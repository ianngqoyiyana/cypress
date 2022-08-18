import _ from 'lodash'
import Debug from 'debug'
import type playwright from 'playwright-webkit'
import type { Automation } from '../automation'
import { normalizeResourceType } from './cdp_automation'

const debug = Debug('cypress:server:browsers:webkit-automation')

export type CyCookie = Pick<chrome.cookies.Cookie, 'name' | 'value' | 'expirationDate' | 'hostOnly' | 'domain' | 'path' | 'secure' | 'httpOnly'> & {
  // use `undefined` instead of `unspecified`
  sameSite?: 'no_restriction' | 'lax' | 'strict'
}

type CookieFilter = {
  name: string
  domain: string
}

const extensionMap = {
  'no_restriction': 'None',
  'lax': 'Lax',
  'strict': 'Strict',
} as const

function convertSameSiteExtensionToCypress (str: CyCookie['sameSite']): 'None' | 'Lax' | 'Strict' | undefined {
  return str ? extensionMap[str] : undefined
}

const normalizeGetCookieProps = (cookie: any): CyCookie => {
  if (cookie.expires === -1) {
    delete cookie.expires
  }

  // Use expirationDate instead of expires 🤷‍♀️
  cookie.expirationDate = cookie.expires
  delete cookie.expires

  if (cookie.sameSite === 'None') {
    cookie.sameSite = 'no_restriction'
  } else if (cookie.sameSite) {
    cookie.sameSite = cookie.sameSite.toLowerCase()
  }

  return cookie as CyCookie
}

const normalizeSetCookieProps = (cookie: CyCookie): playwright.Cookie => {
  return {
    name: cookie.name,
    value: cookie.value,
    path: cookie.path,
    domain: cookie.domain,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    expires: cookie.expirationDate!,
    sameSite: convertSameSiteExtensionToCypress(cookie.sameSite)!,
  }
}

const _domainIsWithinSuperdomain = (domain: string, suffix: string) => {
  const suffixParts = suffix.split('.').filter(_.identity)
  const domainParts = domain.split('.').filter(_.identity)

  return _.isEqual(suffixParts, domainParts.slice(domainParts.length - suffixParts.length))
}

const _cookieMatches = (cookie: any, filter: Record<string, any>) => {
  if (filter.domain && !(cookie.domain && _domainIsWithinSuperdomain(cookie.domain, filter.domain))) {
    return false
  }

  if (filter.path && filter.path !== cookie.path) {
    return false
  }

  if (filter.name && filter.name !== cookie.name) {
    return false
  }

  return true
}

let requestIdCounter = 1
const requestIdMap = new WeakMap<playwright.Request, string>()

type WebKitAutomationOpts = {
  automation: Automation
  browser: playwright.Browser
  shouldMarkAutIframeRequests: boolean
  initialUrl: string
}

export class WebKitAutomation {
  automation: Automation
  private browser: playwright.Browser
  private context!: playwright.BrowserContext
  private page!: playwright.Page
  private shouldMarkAutIframeRequests: boolean

  private constructor (opts: WebKitAutomationOpts) {
    this.automation = opts.automation
    this.browser = opts.browser
    this.shouldMarkAutIframeRequests = opts.shouldMarkAutIframeRequests
  }

  // static initializer to avoid "not definitively declared"
  static async create (opts: WebKitAutomationOpts) {
    const wkAutomation = new WebKitAutomation(opts)

    await wkAutomation.reset(opts.initialUrl)

    return wkAutomation
  }

  public async reset (newUrl?: string) {
    debug('resetting playwright page + context %o', { newUrl })
    // new context comes with new cache + storage
    const newContext = await this.browser.newContext({
      ignoreHTTPSErrors: true,
    })
    const oldPwPage = this.page

    this.page = await newContext.newPage()
    this.context = this.page.context()

    this.attachRequestListeners()

    if (this.shouldMarkAutIframeRequests) await this._markAutIframeRequests()

    let promises: Promise<any>[] = []

    if (oldPwPage) promises.push(oldPwPage.context().close())

    if (newUrl) promises.push(this.page.goto(newUrl))

    if (promises.length) await Promise.all(promises)
  }

  private async _markAutIframeRequests () {
    function isAutIframeRequest (request: playwright.Request) {
      // is an iframe
      return (request.resourceType() === 'document')
        // is a top-level iframe (only 1 parent in chain)
        && request.frame().parentFrame() && !request.frame().parentFrame()?.parentFrame()
        // is not the runner itself
        && !request.url().includes('__cypress')
    }

    await this.context.route('**', (route, request) => {
      if (!isAutIframeRequest(request)) return route.continue()

      return route.continue({
        headers: {
          ...request.headers(),
          'X-Cypress-Is-AUT-Frame': 'true',
        },
      })
    })
  }

  private attachRequestListeners () {
    // emit preRequest to proxy
    this.context.on('request', (request) => {
      // ignore socket.io events
      // TODO: use config.socketIoRoute here instead
      if (request.url().includes('/__socket') || request.url().includes('/__cypress')) return

      // pw does not expose an ID on requests, so create one
      const requestId = String(requestIdCounter++)

      requestIdMap.set(request, requestId)

      const browserPreRequest = {
        requestId,
        method: request.method(),
        url: request.url(),
        // TODO: await request.allHeaders() causes this to not resolve in time
        headers: request.headers(),
        resourceType: normalizeResourceType(request.resourceType()),
        originalResourceType: request.resourceType(),
      }

      debug('received request %o', { browserPreRequest })
      this.automation.onBrowserPreRequest?.(browserPreRequest)
    })

    this.context.on('requestfinished', async (request) => {
      const requestId = requestIdMap.get(request)

      if (!requestId) return

      const response = await request.response()

      const responseReceived = {
        requestId,
        status: response?.status(),
        headers: await response?.allHeaders(),
      }

      debug('received requestfinished %o', { responseReceived })

      this.automation.onRequestEvent?.('response:received', responseReceived)
    })
  }

  private async getCookies () {
    const cookies = await this.context.cookies()

    return cookies.map(normalizeGetCookieProps)
  }

  private async getCookie (filter: CookieFilter) {
    const cookies = await this.context.cookies()

    if (!cookies.length) return null

    const cookie = cookies.find((cookie) => {
      return _cookieMatches(cookie, {
        domain: filter.domain,
        name: filter.name,
      })
    })

    if (!cookie) return null

    return normalizeGetCookieProps(cookie)
  }

  private async clearCookie (filter: CookieFilter) {
    const allCookies = await this.context.cookies()
    const persistCookies = allCookies.filter((cookie) => {
      return !_cookieMatches(cookie, filter)
    })

    await this.context.clearCookies()
    if (persistCookies.length) await this.context.addCookies(persistCookies)
  }

  private async takeScreenshot (data) {
    const buffer = await this.page.screenshot({
      fullPage: data.capture === 'fullPage',
      timeout: 0,
      type: 'png',
    })

    const b64data = buffer.toString('base64')

    return `data:image/png;base64,${b64data}`
  }

  onRequest = async (message, data) => {
    switch (message) {
      case 'is:automation:client:connected':
        return true
      case 'get:cookies':
        return await this.getCookies()
      case 'get:cookie':
        return await this.getCookie(data)
      case 'set:cookie':
        return await this.context.addCookies([normalizeSetCookieProps(data)])
      case 'set:cookies':
        await this.context.clearCookies()

        return await this.context.addCookies(data.map(normalizeSetCookieProps))
      case 'add:cookies':
        return await this.context.addCookies(data.map(normalizeSetCookieProps))
      case 'clear:cookies':
        return await Promise.all(data.map((cookie) => this.clearCookie(cookie)))
      case 'clear:cookie':
        return await this.clearCookie(data)
      case 'take:screenshot':
        return await this.takeScreenshot(data)
      case 'focus:browser:window':
        return await this.context.pages[0]?.bringToFront()
      case 'reset:browser:state':
        return
      case 'reset:browser:tabs:for:next:test':
        if (data.shouldKeepTabOpen) return await this.reset()

        return await this.context.browser()?.close()
      default:
        throw new Error(`No automation handler registered for: '${message}'`)
    }
  }
}

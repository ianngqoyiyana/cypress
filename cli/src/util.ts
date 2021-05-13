import * as _ from 'lodash'
import { trim, equals, evolve } from 'ramda'
import * as os from 'os'
import * as ospath from 'ospath'
import { createHash } from 'crypto'
import lazyAssert from 'lazy-ass'
import { isatty } from 'tty'
import * as path from 'path'
import isCi from 'is-ci'
import execa from 'execa'
import getos from 'getos'
import chalk from 'chalk'
import Promise from 'bluebird'
import cachedir from 'cachedir'
import logSymbols from 'log-symbols'
import executable from 'executable'
import { stripIndent } from 'common-tags'
import supportsColor from 'supports-color'
import isInstalledGlobally from 'is-installed-globally'
import { issuesUrl } from './constants'

import pkg from '../package.json'
import logger from './logger'
import fs from './fs'

import makeDebug from 'debug'

const debug = makeDebug('cypress:cli')

const getosAsync = Promise.promisify(getos)

/**
 * Returns SHA512 of a file
 *
 * Implementation lifted from https://github.com/sindresorhus/hasha
 * but without bringing that dependency (since hasha is Node v8+)
 */
const getFileChecksum = (filename: string) => {
  lazyAssert(!!filename, 'expected filename', filename)

  const hashStream = () => {
    const s = createHash('sha512')

    s.setEncoding('hex')

    return s
  }

  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filename)

    stream.on('error', reject)
    .pipe(hashStream())
    .on('error', reject)
    .on('finish', function () {
      resolve(this.read())
    })
  })
}

const getFileSize = (filename: string) => {
  lazyAssert(!!filename, 'expected filename', filename)

  return fs.statAsync(filename).get('size')
}

const isBrokenGtkDisplayRe = /Gtk: cannot open display/

const stringify = (val: unknown) => {
  return _.isObject(val) ? JSON.stringify(val) : val
}

export const normalizeModuleOptions = (options = {}) => _.mapValues(options, stringify)

/**
 * Returns true if the platform is Linux. We do a lot of different
 * stuff on Linux (like Xvfb) and it helps to has readable code
 */
const isLinux = () => {
  return os.platform() === 'linux'
}

/**
   * If the DISPLAY variable is set incorrectly, when trying to spawn
   * Cypress executable we get an error like this:
  ```
  [1005:0509/184205.663837:WARNING:browser_main_loop.cc(258)] Gtk: cannot open display: 99
  ```
   */
const isBrokenGtkDisplay = (str: string) => {
  return isBrokenGtkDisplayRe.test(str)
}

const isPossibleLinuxWithIncorrectDisplay = () => {
  return isLinux() && process.env.DISPLAY
}

const logBrokenGtkDisplayWarning = () => {
  debug('Cypress exited due to a broken gtk display because of a potential invalid DISPLAY env... retrying after starting Xvfb')

  // if we get this error, we are on Linux and DISPLAY is set
  logger.warn(stripIndent`

    ${logSymbols.warning} Warning: Cypress failed to start.

    This is likely due to a misconfigured DISPLAY environment variable.

    DISPLAY was set to: "${process.env.DISPLAY}"

    Cypress will attempt to fix the problem and rerun.
  `)

  logger.warn()
}

function stdoutLineMatches (expectedLine: string, stdout: string) {
  const lines = stdout.split('\n').map(trim)
  const lineMatches = equals(expectedLine)

  return lines.some(lineMatches)
}

/**
 * Confirms if given value is a valid CYPRESS_INTERNAL_ENV value. Undefined values
 * are valid, because the system can set the default one.
 *
 * @param {string} value
 * @example util.isValidCypressInternalEnvValue(process.env.CYPRESS_INTERNAL_ENV)
 */
function isValidCypressInternalEnvValue (value: string) {
  if (_.isUndefined(value)) {
    // will get default value
    return true
  }

  // names of config environments, see "packages/server/config/app.yml"
  const names = ['development', 'test', 'staging', 'production']

  return _.includes(names, value)
}

/**
 * Confirms if given value is a non-production CYPRESS_INTERNAL_ENV value.
 * Undefined values are valid, because the system can set the default one.
 *
 * @param {string} value
 * @example util.isNonProductionCypressInternalEnvValue(process.env.CYPRESS_INTERNAL_ENV)
 */
function isNonProductionCypressInternalEnvValue (value: string) {
  return !_.isUndefined(value) && value !== 'production'
}

/**
 * Prints NODE_OPTIONS using debug() module, but only
 * if DEBUG=cypress... is set
 */
function printNodeOptions (log = debug) {
  if (!log.enabled) {
    return
  }

  if (process.env.NODE_OPTIONS) {
    log('NODE_OPTIONS=%s', process.env.NODE_OPTIONS)
  } else {
    log('NODE_OPTIONS is not set')
  }
}

/**
 * Removes double quote characters
 * from the start and end of the given string IF they are both present
 *
 * @param {string} str Input string
 * @returns {string} Trimmed string or the original string if there are no double quotes around it.
 * @example
  ```
  dequote('"foo"')
  // returns string 'foo'
  dequote('foo')
  // returns string 'foo'
  ```
 */
const dequote = (str: string) => {
  if (str.length > 1 && str[0] === '"' && str[str.length - 1] === '"') {
    return str.substr(1, str.length - 2)
  }

  return str
}

const parseOpts = (opts) => {
  opts = _.pick(opts,
    'browser',
    'cachePath',
    'cacheList',
    'cacheClear',
    'cachePrune',
    'ciBuildId',
    'config',
    'configFile',
    'cypressVersion',
    'destination',
    'detached',
    'dev',
    'exit',
    'env',
    'force',
    'global',
    'group',
    'headed',
    'headless',
    'key',
    'path',
    'parallel',
    'port',
    'project',
    'quiet',
    'reporter',
    'reporterOptions',
    'record',
    'runProject',
    'spec',
    'tag')

  if (opts.exit) {
    opts = _.omit(opts, 'exit')
  }

  // some options might be quoted - which leads to unexpected results
  // remove double quotes from certain options
  const removeQuotes = {
    group: dequote,
    ciBuildId: dequote,
  }
  const cleanOpts = evolve(removeQuotes, opts)

  debug('parsed cli options %o', cleanOpts)

  return cleanOpts
}

/**
 * Copy of packages/server/lib/browsers/utils.ts
 * because we need same functionality in CLI to show the path :(
 */
const getApplicationDataFolder = (...paths: string[]) => {
  const { env } = process

  // allow overriding the app_data folder
  const folder = env.CYPRESS_KONFIG_ENV || env.CYPRESS_INTERNAL_ENV || 'development'

  const PRODUCT_NAME = pkg.productName || pkg.name
  const OS_DATA_PATH = ospath.data()

  const ELECTRON_APP_DATA_PATH = path.join(OS_DATA_PATH, PRODUCT_NAME)

  const p = path.join(ELECTRON_APP_DATA_PATH, 'cy', folder, ...paths)

  return p
}

const util = {
  parseOpts,
  isValidCypressInternalEnvValue,
  isNonProductionCypressInternalEnvValue,
  printNodeOptions,

  isCi () {
    return isCi
  },

  getEnvOverrides (options = {}) {
    return _
    .chain({})
    .extend(util.getEnvColors())
    .extend(util.getForceTty())
    .omitBy(_.isUndefined) // remove undefined values
    .mapValues((value) => { // stringify to 1 or 0
      return value ? '1' : '0'
    })
    .value()
  },

  getForceTty () {
    return {
      FORCE_STDIN_TTY: util.isTty(process.stdin.fd),
      FORCE_STDOUT_TTY: util.isTty(process.stdout.fd),
      FORCE_STDERR_TTY: util.isTty(process.stderr.fd),
    }
  },

  getEnvColors () {
    const sc = util.supportsColor()

    return {
      FORCE_COLOR: sc,
      DEBUG_COLORS: sc,
      MOCHA_COLORS: sc ? true : undefined,
    }
  },

  isTty (fd: number) {
    return isatty(fd)
  },

  supportsColor () {
    // if we've been explictly told not to support
    // color then turn this off
    if (process.env.NO_COLOR) {
      return false
    }

    // https://github.com/cypress-io/cypress/issues/1747
    // always return true in CI providers
    if (process.env.CI) {
      return true
    }

    // ensure that both stdout and stderr support color
    return Boolean(supportsColor.stdout) && Boolean(supportsColor.stderr)
  },

  cwd () {
    return process.cwd()
  },

  pkgVersion () {
    return pkg.version
  },

  exit (code: number) {
    process.exit(code)
  },

  logErrorExit1 (err: Error) {
    logger.error(err.message)

    process.exit(1)
  },

  dequote,

  titleize (...args) {
    // prepend first arg with space
    // and pad so that all messages line up
    args[0] = _.padEnd(` ${args[0]}`, 24)

    // get rid of any falsy values
    args = _.compact(args)

    return chalk.blue(...args)
  },

  calculateEta (percent: number, elapsed: number) {
    // returns the number of seconds remaining

    // if we're at 100% already just return 0
    if (percent === 100) {
      return 0
    }

    // take the percentage and divide by one
    // and multiple that against elapsed
    // subtracting what's already elapsed
    return elapsed * (1 / (percent / 100)) - elapsed
  },

  convertPercentToPercentage (num: number) {
    // convert a percent with values between 0 and 1
    // with decimals, so that it is between 0 and 100
    // and has no decimal places
    return Math.round(_.isFinite(num) ? (num * 100) : 0)
  },

  secsRemaining (eta: number) {
    // calculate the seconds reminaing with no decimal places
    return (_.isFinite(eta) ? (eta / 1000) : 0).toFixed(0)
  },

  setTaskTitle (task, title: string, renderer) {
    // only update the renderer title when not running in CI
    if (renderer === 'default' && task.title !== title) {
      task.title = title
    }
  },

  isInstalledGlobally () {
    return isInstalledGlobally
  },

  isSemver (str: string) {
    return /^(\d+\.)?(\d+\.)?(\*|\d+)$/.test(str)
  },

  isExecutableAsync (filePath: string) {
    return Promise.resolve(executable(filePath))
  },

  isLinux,

  getOsVersionAsync () {
    return Promise.try(() => {
      if (isLinux()) {
        const osInfoPromise = getosAsync() as Promise<getos.LinuxOs>

        return osInfoPromise
        .then((osInfo) => {
          return [osInfo.dist, osInfo.release].join(' - ')
        })
        .catch(() => {
          return os.release()
        })
      }

      return os.release()
    })
  },

  // attention:
  // when passing relative path to NPM post install hook, the current working
  // directory is set to the `node_modules/cypress` folder
  // the user is probably passing relative path with respect to root package folder
  formAbsolutePath (filename: string) {
    if (path.isAbsolute(filename)) {
      return filename
    }

    return path.join(process.cwd(), '..', '..', filename)
  },

  getEnv (varName: string, trim: boolean) {
    lazyAssert(!!varName, 'expected environment variable name, not', varName)

    const configVarName = `npm_config_${varName}`
    const packageConfigVarName = `npm_package_config_${varName}`

    let result

    if (process.env.hasOwnProperty(varName)) {
      debug(`Using ${varName} from environment variable`)

      result = process.env[varName]
    } else if (process.env.hasOwnProperty(configVarName)) {
      debug(`Using ${varName} from npm config`)

      result = process.env[configVarName]
    } else if (process.env.hasOwnProperty(packageConfigVarName)) {
      debug(`Using ${varName} from package.json config`)

      result = process.env[packageConfigVarName]
    }

    // environment variables are often set double quotes to escape characters
    // and on Windows it can lead to weird things: for example
    //  set FOO="C:\foo.txt" && node -e "console.log('>>>%s<<<', process.env.FOO)"
    // will print
    //    >>>"C:\foo.txt" <<<
    // see https://github.com/cypress-io/cypress/issues/4506#issuecomment-506029942
    // so for sanity sake we should first trim whitespace characters and remove
    // double quotes around environment strings if the caller is expected to
    // use this environment string as a file path
    return trim ? dequote(_.trim(result)) : result
  },

  isPostInstall () {
    return process.env.npm_lifecycle_event === 'postinstall'
  },

  exec: execa,

  stdoutLineMatches,

  issuesUrl,

  isBrokenGtkDisplay,

  logBrokenGtkDisplayWarning,

  isPossibleLinuxWithIncorrectDisplay,

  getFileChecksum,

  getFileSize,

  getApplicationDataFolder,
}

module.exports = util

export const getPlatformInfo = () => {
  return util.getOsVersionAsync().then((version) => {
    return stripIndent`
      Platform: ${os.platform()} (${version})
      Cypress Version: ${util.pkgVersion()}
    `
  })
}

export const getCacheDir = () => cachedir('Cypress')

export const getGitHubIssueUrl = (id: number) => {
  lazyAssert(id > 0, 'github issue should be a positive number', id)
  lazyAssert(_.isInteger(id), 'github issue should be an integer', id)

  return `${issuesUrl}/${id}`
}

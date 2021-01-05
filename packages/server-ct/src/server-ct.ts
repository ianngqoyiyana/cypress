import http from 'http'
import { promisify } from 'util'
import _debug from 'debug'
import express, { Request } from 'express'
import Bluebird from 'bluebird'
import allowDestroy from '@packages/server/lib/util/server_destroy'
import templateEngine from '@packages/server/lib/template_engine'
import { Socket } from './socket-ct'
import { initializeRoutes } from './routes-ct'
import {
  uri,
} from '@packages/network'

const debug = _debug('cypress:server-ct:server')

export class Server {
  private _request: Request
  private _middleware
  private _server: http.Server
  private isListening: boolean
  private _socket: Socket
  private _baseUrl: string
  private _nodeProxy
  private _fileServer
  private _httpsProxy
  private _urlResolver
  private automation
  private server: Server
  private projectRoot: string
  private spec: Cypress.Cypress['spec']
  private browser: unknown

  constructor () {
    if (!(this instanceof Server)) {
      return new Server()
    }
  }

  createExpressApp (config) {
    const { morgan } = config
    const app = express()

    // set the cypress config from the cypress.json file
    app.set('view engine', 'html')

    // since we use absolute paths, configure express-handlebars to not automatically find layouts
    // https://github.com/cypress-io/cypress/issues/2891
    app.engine('html', templateEngine.render)

    app.use(require('cookie-parser')())

    if (morgan) {
      app.use(require('morgan')('dev'))
    }

    // errorhandler
    app.use(require('errorhandler')())

    // remove the express powered-by header
    app.disable('x-powered-by')

    return app
  }

  createRoutes (...args: unknown[]) {
    return initializeRoutes.apply(null, args)
  }

  getHttpServer () {
    return this._server
  }

  open (config = {}, project, onError, onWarning) {
    debug('server open')

    return Bluebird.try(() => {
      const app = this.createExpressApp(config)

      this._socket = new Socket(config)

      this.createRoutes({
        app,
        config,
        // onError,
        project,
      })

      return this.createServer(app, config, project, this._request, onWarning)
    })
  }

  createServer (app, config, project, request, onWarning) {
    return new Bluebird((resolve, reject) => {
      const { port } = config

      this._server = http.createServer(app)

      allowDestroy(this._server)

      const onError = (err) => {
        // if the server bombs before starting
        // and the err no is EADDRINUSE
        // then we know to display the custom err message
        if (err.code === 'EADDRINUSE') {
          return reject(`Port ${port} is already in use`)
        }
      }

      this._server.once('error', onError)

      return this._listen(port, onError)
      .then((port) => {
        return resolve([port])
      })
    })
  }

  _listen (port, onError) {
    return new Bluebird((resolve) => {
      const listener = () => {
        const address = this._server.address()

        this.isListening = true

        debug('Server listening on ', address)

        this._server.removeListener('error', onError)

        return resolve(typeof address === 'string' ? address : address.port)
      }

      return this._server.listen(port || 0, '127.0.0.1', listener)
    })
  }

  _callRequestListeners (server, listeners, req, res) {
    return listeners.map((listener) => {
      return listener.call(server, req, res)
    })
  }

  _destroyAsync () {
    allowDestroy(this._server)

    return promisify(this._server.close)()
  }

  _close () {
    // bail early we dont have a server or we're not
    // currently listening
    if (!this._server || !this.isListening) {
      return Bluebird.resolve()
    }

    return this._destroyAsync()
    .then(() => {
      this.isListening = false
    }).catch(() => { }) // don't catch any errors
  }

  close () {
    return Bluebird.all([
      this._close(),
      this._socket != null ? this._socket.close() : undefined,
      this._fileServer != null ? this._fileServer.close() : undefined,
      this._httpsProxy != null ? this._httpsProxy.close() : undefined,
    ])
    .then(() => {
      this._middleware = null
    })
  }

  reset () {
    debug('resetting project instance %s', this.projectRoot)

    this.spec = null
    this.browser = null

    try {
      if (this.automation) {
        this.automation.reset()
      }

      let state

      if (this.server) {
        state = this.server.reset()
      }

      return state
    } catch (e) {
      // do not do anything
    }
  }

  end () {
    return this._socket && this._socket.end()
  }

  changeToUrl (url) {
    return this._socket && this._socket.changeToUrl(url)
  }

  onTestFileChange (filePath) {
    return this._socket && this._socket.onTestFileChange(filePath)
  }

  sendSpecList (specs) {
    return this._socket && this._socket.sendSpecList(specs)
  }

  onRequest (fn) {
    this._middleware = fn
  }

  onNextRequest (fn) {
    return this.onRequest((...args) => {
      fn.apply(this, args)

      this._middleware = null
    })
  }

  _normalizeReqUrl(server) {
    const setProxiedUrl = function (req) {
      console.log(`REQ: ${req.url}`)
      // proxiedUrl is the full URL with scheme, host, and port
      // it will only be fully-qualified if the request was proxied.

      // this function will set the URL of the request to be the path
      // only, which can then be used to proxy the request.

      // bail if we've already proxied the url
      if (req.proxiedUrl) {
        return
      }

      // backup the original proxied url
      // and slice out the host/origin
      // and only leave the path which is
      // how browsers would normally send
      // use their url
      req.proxiedUrl = uri.removeDefaultPort(req.url).format()

      req.url = uri.getPath(req.url)
      console.log(`PROXIED: ${req.url}`)
    }

    // because socket.io removes all of our request
    // events, it forces the socket.io traffic to be
    // handled first.
    // however we need to basically do the same thing
    // it does and after we call into socket.io go
    // through and remove all request listeners
    // and change the req.url by slicing out the host
    // because the browser is in proxy mode
    const listeners = server.listeners('request').slice(0)

    server.removeAllListeners('request')

    return server.on('request', (req, res) => {
      setProxiedUrl(req)

      return this._callRequestListeners(server, listeners, req, res)
    })
  }

  startWebsockets (config, options = {}) {
    this._socket.startListening(this._server, config, options)
    return this._normalizeReqUrl(this._server)
  }
}

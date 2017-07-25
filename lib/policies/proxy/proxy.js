'use strict';

const httpProxy = require('http-proxy');
const lodash = require('lodash');
const _ = require('lodash');
const logger = require('../../logger').gateway;

const ConfigurationError = require('../../errors').ConfigurationError;

module.exports = function (params, config) {
  let serviceEndpoint = lodash.get(config.gatewayConfig, ['serviceEndpoints',
    params.serviceEndpoint, 'url'
  ]);
  if (!serviceEndpoint) {
    throw new ConfigurationError(
      `Service endpoint ${params.serviceEndpoint} (referenced in 'proxy' ` +
      'policy configuration) does not exist');
  }

  let proxy = httpProxy.createProxyServer({
    target: serviceEndpoint,
    changeOrigin: params.changeOrigin || false
  });
  let wsInitialized = false;
  let wsUpgradeDebounced = _.debounce(handleUpgrade);
  proxy.on('error', (err, _req, res) => {
    logger.warn(err);

    if (!res.headersSent) {
      res.status(502).send('Bad gateway.');
    } else {
      res.end();
    }
  });

  return function proxyHandler (req, res, _next) {
    logger.debug(`proxying to ${serviceEndpoint}, ${req.method} ${req.url}`);
    proxy.web(req, res);

    if (proxyOptions.ws === true) {
      // use initial request to access the server object to subscribe to http upgrade event
      catchUpgradeRequest(req.connection.server);
    }
  };

  function catchUpgradeRequest (server) {
    // subscribe once; don't subscribe on every request...
    // https://github.com/chimurai/http-proxy-middleware/issues/113
    if (!wsInitialized) {
      server.on('upgrade', wsUpgradeDebounced);
      wsInitialized = true;
    }
  }

  function handleUpgrade (req, socket, head) {
    // set to initialized when used externally
    wsInitialized = true;

    let activeProxyOptions = prepareProxyRequest(req);
    proxy.ws(req, socket, head, activeProxyOptions);
    logger.info('[HPM] Upgrading to WebSocket');
  }

  function prepareProxyRequest (req) {
    // https://github.com/chimurai/http-proxy-middleware/issues/17
    // https://github.com/chimurai/http-proxy-middleware/issues/94
    req.url = (req.originalUrl || req.url);

    // store uri before it gets rewritten for logging
    let originalPath = req.url;
    let newProxyOptions = _.assign({}, proxyOptions);

    // Apply in order:
    // 1. option.router
    // 2. option.pathRewrite
    __applyRouter(req, newProxyOptions);
    __applyPathRewrite(req, pathRewriter);

    // debug logging for both http(s) and websockets
    if (proxyOptions.logLevel === 'debug') {
      let arrow = getArrow(originalPath, req.url, proxyOptions.target, newProxyOptions.target);
      logger.debug('[HPM] %s %s %s %s', req.method, originalPath, arrow, newProxyOptions.target);
    }

    return newProxyOptions;
  }
};

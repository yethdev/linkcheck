const { Agent, setGlobalDispatcher } = require('undici');

setGlobalDispatcher(new Agent({
  keepAliveTimeout: 60_000,
  keepAliveMaxTimeout: 120_000,
  connections: 64,
  pipelining: 1,
  bodyTimeout: 10_000,
  headersTimeout: 10_000,
}));

module.exports = { fetchURL: fetch };
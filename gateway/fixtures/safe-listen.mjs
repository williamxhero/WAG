import http from 'node:http';

// Fetch port blocking: https://fetch.spec.whatwg.org/#port-blocking
// Keep port0 allocation, but never publish a listener that native fetch refuses.
const forbiddenPorts = new Set([1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]);

export class SafeListenError extends Error {
  constructor(code, message, details = {}) {
    super(message, details.cause ? { cause: details.cause } : undefined);
    this.name = 'SafeListenError';
    this.code = code;
    Object.assign(this, details);
  }
}

function close(server) {
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

function bind(server, options, listen) {
  return new Promise((resolve, reject) => {
    const finish = error => {
      server.off('error', onError);
      server.off('listening', onListening);
      error ? reject(error) : resolve();
    };
    const onError = error => finish(error);
    const onListening = () => finish();
    server.once('error', onError);
    server.once('listening', onListening);
    try { listen(server, options); } catch (error) { finish(error); }
  });
}

export async function listenHttp(server, options = {}) {
  const invalid = () => new SafeListenError('WAG_TEST_SAFE_LISTEN_INVALID_OPTIONS', 'Expected an idle HTTP server, host and 1..25 listen attempts');
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw invalid();
  const { host = '127.0.0.1', maxAttempts = 25, listen = (server, options) => server.listen(options) } = options;
  if (!server || ['listen', 'once', 'off', 'address', 'close'].some(name => typeof server[name] !== 'function') || server.listening
      || typeof host !== 'string' || !host.trim() || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 25 || typeof listen !== 'function') throw invalid();
  let reason; let cause;
  for (let attempts = 1; attempts <= maxAttempts; attempts++) {
    try { await bind(server, { port: 0, host }, listen); } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
      reason = 'address_in_use'; cause = error;
      continue;
    }
    const port = server.address().port;
    if (!forbiddenPorts.has(port)) return { port, url: `http://${host.includes(':') ? `[${host}]` : host}:${port}` };
    await close(server);
    reason = 'forbidden_port'; cause = undefined;
  }
  throw new SafeListenError('WAG_TEST_SAFE_LISTEN_EXHAUSTED', 'Could not allocate a Fetch-safe HTTP port', { attempts: maxAttempts, reason, ...(cause ? { cause } : {}) });
}

export async function reserveHttpPort(options = {}) {
  const server = http.createServer();
  const { port } = await listenHttp(server, options);
  let released;
  return { port, release: () => released ??= close(server) };
}

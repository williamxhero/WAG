// Loaded only by the offline read test child; production address policy is unchanged.
import dns from 'node:dns/promises';
import http from 'node:http';

const originHosts = new Set(['reader.example.test', 'final.example.test']);
const canonicalLinks = {
  missing: '',
  attribute: '<link rel="canonical">',
  empty: '<link rel="canonical" href="">',
  whitespace: '<link rel="canonical" href="   ">',
  malformed: '<link rel="canonical" href="https://[invalid">',
  scheme: '<link rel="canonical" href="javascript:alert(1)">',
  relative: '<link rel="canonical" href="../declared?edition=1">',
  absolute: '<link rel="canonical" href="https://canonical.example.test/declared">',
};

const origin = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://fixture.test');
  if (url.pathname === '/crawl' && req.method === 'POST') {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const input = JSON.parse(Buffer.concat(chunks));
      if (new URL(input.urls[0]).hostname !== 'final.example.test') {
        res.writeHead(400).end('crawler must receive the final response URL');
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ results: [{ markdown: { raw_markdown: 'Rendered fixture article.' } }] }));
    });
    return;
  }
  const slug = url.pathname.split('/').at(-1);
  if (!Object.hasOwn(canonicalLinks, slug)) {
    res.writeHead(404).end('unexpected fixture destination');
    return;
  }
  if (url.pathname.startsWith('/start/')) {
    res.writeHead(302, { location: `http://final.example.test/articles/${slug}?tracking=1` }).end();
    return;
  }
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('date', 'Mon, 28 Sep 2026 00:00:00 GMT');
  res.end(`<!doctype html><html><head><title>Fixture article</title>${canonicalLinks[slug]}</head><body><article>Static fixture article.</article></body></html>`);
});
// The same local origin accepts CONNECT and parses the following tunneled request.
origin.on('connect', (_req, socket, head) => {
  socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
  if (head.length) socket.unshift(head);
  origin.emit('connection', socket);
});
await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve));
const port = origin.address().port;
process.env.EGRESS_PROXY = `http://127.0.0.1:${port}`;
process.env.CRAWL4AI_URL = `http://127.0.0.1:${port}`;

// Substitute only external DNS and HTTP transport, never gateway extraction logic.
dns.lookup = async host => {
  if (!originHosts.has(host)) throw new Error(`unexpected DNS destination: ${host}`);
  return [{ address: '8.8.8.8', family: 4 }];
};
const request = http.request;
http.request = function (options, ...args) {
  const host = options.hostname ?? options.host;
  if (originHosts.has(host)) {
    return request.call(this, { ...options, hostname: '127.0.0.1', host: '127.0.0.1', port }, ...args);
  }
  if (host !== '127.0.0.1' || Number(options.port) !== port) {
    throw new Error(`unexpected HTTP destination: ${host}`);
  }
  return request.call(this, options, ...args);
};

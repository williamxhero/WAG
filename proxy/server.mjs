import dns from 'node:dns/promises';
import http from 'node:http';
import net from 'node:net';
import { URL } from 'node:url';

const host = process.env.EGRESS_PROXY_HOST ?? '127.0.0.1';
const port = Number(process.env.EGRESS_PROXY_PORT ?? 7895);
const upstream = process.env.EGRESS_UPSTREAM ?? 'http://127.0.0.1:7890';
const connectTimeoutMs = Number(process.env.EGRESS_CONNECT_TIMEOUT_MS ?? 10000);
const maxHostConcurrency = Number(process.env.EGRESS_MAX_HOST_CONCURRENCY ?? 8);
const upstreamUrl = new URL(upstream);
const hostSlots = new Map();
const isPublic = address => {
  const value = address.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  if (mapped) return isPublic(mapped[1]);
  if (value.includes(':')) return !/^(::|::1|fc|fd|fe[89ab]|ff|2001:db8:|2001:2:|2001:10:|2002:|64:ff9b:1:)/i.test(value);
  const [a, b, c] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 100 && b >= 64 && b <= 127 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 0 || b === 168) || a === 198 && (b === 18 || b === 19 || b === 51) || a === 203 && b === 0 && c === 113 || a >= 224);
};
async function resolve(name) { const records = await dns.lookup(name, { all: true, verbatim: true }); if (!records.length || records.some(x => !isPublic(x.address))) throw new Error('blocked destination'); return records[0]; }
function validPort(value) { return Number(value) === 80 || Number(value) === 443; }
async function tunnel(req, client, head) {
  const [name, portText] = req.url.split(':'); if (!name || !validPort(portText)) return client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  try { await resolve(name); } catch { return client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); }
  const slot = hostSlots.get(name) ?? 0;
  if (slot >= maxHostConcurrency) return client.end('HTTP/1.1 429 Too Many Requests\r\nRetry-After: 5\r\n\r\n');
  hostSlots.set(name, slot + 1);
  const socket = net.connect({ host: upstreamUrl.hostname, port: Number(upstreamUrl.port || 80) });
  let handshake = '';
  let closed = false;
  const teardown = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    client.destroy();
    socket.destroy();
    const active = (hostSlots.get(name) ?? 1) - 1;
    if (active > 0) hostSlots.set(name, active); else hostSlots.delete(name);
  };
  const timer = setTimeout(teardown, connectTimeoutMs);
  client.once('error', teardown);
  client.once('close', teardown);
  socket.once('error', teardown);
  socket.once('close', teardown);
  socket.once('connect', () => socket.write(`CONNECT ${name}:${portText} HTTP/1.1\r\nHost: ${name}:${portText}\r\nConnection: keep-alive\r\n\r\n`));
  socket.on('data', chunk => {
    if (handshake === null) return;
    handshake += chunk.toString('latin1');
    if (handshake.length > 16384) return teardown();
    const end = handshake.indexOf('\r\n\r\n');
    if (end < 0) return;
    if (!/^HTTP\/1\.[01] 2\d\d/.test(handshake)) return teardown();
    const rest = Buffer.from(handshake.slice(end + 4), 'latin1');
    handshake = null;
    clearTimeout(timer);
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) socket.write(head);
    if (rest.length) client.write(rest);
    client.pipe(socket);
    socket.pipe(client);
  });
}
const server = http.createServer(async (req, res) => { try { const url = new URL(req.url); if (!['http:', 'https:'].includes(url.protocol) || !validPort(url.port || (url.protocol === 'https:' ? 443 : 80))) throw new Error(); await resolve(url.hostname); res.writeHead(501); res.end('CONNECT required'); } catch { res.writeHead(403); res.end('blocked destination'); } });
server.on('clientError', (_error, socket) => socket.destroy());
server.on('connect', tunnel); server.listen(port, host, () => console.log(JSON.stringify({ event: 'egress_proxy_listening', host, port, upstream })));

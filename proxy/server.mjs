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
if (upstreamUrl.protocol !== 'http:' || upstreamUrl.username || upstreamUrl.password) {
  throw new Error('EGRESS_UPSTREAM must be an unauthenticated HTTP CONNECT proxy; other transports cannot enforce address pinning');
}
const hostSlots = new Map();
const isPublic = address => {
  const family = net.isIP(address);
  if (!family) return false;
  // Canonicalize before prefix checks so expanded IPv6 cannot hide special-use ranges.
  const value = family === 6 ? new URL(`http://[${address}]`).hostname.slice(1, -1) : address;
  const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(value);
  if (mapped) {
    const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16);
    return isPublic(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  if (family === 6) return /^[23][0-9a-f]{3}:/.test(value) && !/^(2001::|2001:db8:|2001:2:|2001:10:|2001:20:|2001:30:|2002:|3fff:)/i.test(value);
  const [a, b, c] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 100 && b >= 64 && b <= 127 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 0 || b === 168) || a === 198 && (b === 18 || b === 19 || b === 51) || a === 203 && b === 0 && c === 113 || a >= 224);
};
async function resolve(name) {
  const family = net.isIP(name);
  const records = family ? [{ address: name, family }] : await dns.lookup(name, { all: true, verbatim: true });
  if (!records.length || records.some(x => !net.isIP(x.address) || !isPublic(x.address))) throw new Error('blocked destination');
  return records;
}
function validPort(value) { return Number(value) === 80 || Number(value) === 443; }
function parseAuthority(value) {
  const match = /^(\[[^\]]+\]|[^:[\]\/\\?#@\s%]+):(80|443)$/.exec(value);
  if (!match) throw new Error('invalid authority');
  const url = new URL(`http://${value}`);
  const name = url.hostname.replace(/^\[|\]$/g, '');
  if (match[1].startsWith('[') && net.isIP(name) !== 6) throw new Error('invalid IPv6 authority');
  return { name, portText: match[2] };
}
function formatAuthority(address, portText) { return `${net.isIP(address) === 6 ? `[${address}]` : address}:${portText}`; }
async function tunnel(req, client, head) {
  let name, portText;
  try { ({ name, portText } = parseAuthority(req.url)); } catch { return client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); }
  let checked;
  try { checked = await resolve(name); } catch { return client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); }
  const slot = hostSlots.get(name) ?? 0;
  if (slot >= maxHostConcurrency) return client.end('HTTP/1.1 429 Too Many Requests\r\nRetry-After: 5\r\n\r\n');
  hostSlots.set(name, slot + 1);
  let socket;
  let nextAddress = 0;
  let closed = false;
  const teardown = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    client.destroy();
    socket?.destroy();
    const active = (hostSlots.get(name) ?? 1) - 1;
    if (active > 0) hostSlots.set(name, active); else hostSlots.delete(name);
  };
  // The whole checked-set attempt shares one deadline and one host slot.
  const timer = setTimeout(teardown, connectTimeoutMs);
  client.once('error', teardown);
  client.once('close', teardown);
  const attempt = () => {
    if (closed) return;
    if (nextAddress >= checked.length) return teardown();
    // Only numeric destinations cross the upstream boundary. The client retains
    // its logical HTTP Host and TLS identity; the proxy does not terminate TLS.
    const authority = formatAuthority(checked[nextAddress++].address, portText);
    const connection = net.connect({ host: upstreamUrl.hostname.replace(/^\[|\]$/g, ''), port: Number(upstreamUrl.port || 80) });
    socket = connection;
    let handshake = '';
    let failed = false;
    const fail = () => {
      if (failed || closed) return;
      failed = true;
      connection.destroy();
      if (handshake === null) teardown(); else attempt();
    };
    connection.once('error', fail);
    connection.once('close', fail);
    connection.once('connect', () => connection.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nConnection: keep-alive\r\n\r\n`));
    connection.on('data', chunk => {
      if (failed || closed || handshake === null) return;
      handshake += chunk.toString('latin1');
      if (handshake.length > 16384) return teardown();
      const end = handshake.indexOf('\r\n\r\n');
      if (end < 0) return;
      if (!/^HTTP\/1\.[01] 2\d\d(?: |\r)/.test(handshake)) return fail();
      const rest = Buffer.from(handshake.slice(end + 4), 'latin1');
      handshake = null;
      clearTimeout(timer);
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) connection.write(head);
      if (rest.length) client.write(rest);
      client.pipe(connection);
      connection.pipe(client);
    });
  };
  attempt();
}
const server = http.createServer(async (req, res) => { try { const url = new URL(req.url); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !validPort(url.port || (url.protocol === 'https:' ? 443 : 80))) throw new Error(); await resolve(url.hostname); res.writeHead(501); res.end('CONNECT required'); } catch { res.writeHead(403); res.end('blocked destination'); } });
server.on('clientError', (_error, socket) => socket.destroy());
server.on('connect', tunnel); server.listen(port, host, () => console.log(JSON.stringify({ event: 'egress_proxy_listening', host, port, upstream })));

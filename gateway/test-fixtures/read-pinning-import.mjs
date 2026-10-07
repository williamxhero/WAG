// Isolated child-process fixture only: no production switches or policy bypasses.
import dns from 'node:dns/promises';
import net from 'node:net';

const answers = JSON.parse(process.env.WAG_FIXTURE_DNS);
const calls = new Map();
dns.lookup = async name => {
  const call = (calls.get(name) ?? 0) + 1;
  calls.set(name, call);
  process.send?.({ name, call });
  if (!Object.hasOwn(answers, name)) throw new Error(`unexpected fixture DNS: ${name}`);
  const sets = answers[name];
  return sets[Math.min(call - 1, sets.length - 1)].map(address => ({ address, family: net.isIP(address) }));
};
// Even a regression must never dial one of the synthetic public addresses.
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const options = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host = typeof options === 'object' ? options.host : args[1];
  if (host && host !== '127.0.0.1' && host !== 'localhost') throw new Error(`nonlocal fixture transport: ${host}`);
  return connect.apply(this, args);
};

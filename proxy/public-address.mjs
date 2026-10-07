import net from 'node:net';

function ipv6Value(address) {
  const [left, right] = address.split('::');
  const before = left ? left.split(':') : [];
  const after = right ? right.split(':') : [];
  const groups = right === undefined ? before : [...before, ...Array(8 - before.length - after.length).fill('0'), ...after];
  return groups.reduce((value, group) => (value << 16n) | BigInt(parseInt(group, 16)), 0n);
}
const excludedIPv6 = [
  ['2001::', 32],          // Teredo, including nonzero interior subnets.
  ['2001:2::', 48],        // Benchmarking.
  ['2001:10::', 28],       // ORCHID.
  ['2001:20::', 28],       // ORCHIDv2.
  ['2001:30::', 28],       // Drone Remote ID identifiers.
  ['2001:db8::', 32],      // Documentation.
  ['2002::', 16],          // 6to4 embeds an unchecked IPv4 destination.
  ['3fff::', 20],          // Documentation.
].map(([network, prefix]) => ({ network: ipv6Value(network), shift: BigInt(128 - prefix) }));

// Only address classification is shared. Callers retain their own IPv4 policy,
// DNS validation, budgets and typed error contracts.
export function isPublicAddress(address, isPublicIPv4) {
  const family = net.isIP(address);
  if (family === 4) return isPublicIPv4(address);
  if (family !== 6) return false;
  const canonical = new URL(`http://[${address}]`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(canonical);
  if (mapped) {
    const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16);
    return isPublicIPv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  const value = ipv6Value(canonical);
  return value >> 125n === 1n && !excludedIPv6.some(({ network, shift }) => value >> shift === network >> shift);
}

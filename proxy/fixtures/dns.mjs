// Resolver boundary for isolated child-process tests only. Production never loads this module.
import dns from 'node:dns/promises';

const calls = new Map();
const answers = {
  'rebind.test': ['8.8.8.8'],
  'mixed.test': ['8.8.8.8', '127.0.0.1'],
  'mixed-orchid.test': ['8.8.8.8', '2001:21::1'],
  'expanded-private.test': ['8.8.8.8', '0:0:0:0:0:0:0:1'],
  'discard.test': ['100::1'],
  'expanded-doc.test': ['2001:0db8:0:0::1'],
  'invalid-answer.test': ['not-an-ip'],
  'ipv6.test': ['2606:4700:4700::1111'],
  'retry.test': ['8.8.8.8', '1.1.1.1'],
  'navigation.test': ['8.8.8.8'],
  'redirect.test': ['1.1.1.1'],
  'asset.test': ['9.9.9.9'],
  'blocked.test': ['127.0.0.1'],
};
dns.lookup = async name => {
  if (!(name in answers)) throw new Error(`offline fixture has no DNS answer for ${name}`);
  const count = (calls.get(name) ?? 0) + 1;
  calls.set(name, count);
  const addresses = ['rebind.test', 'retry.test'].includes(name) && count > 1 ? ['127.0.0.1'] : answers[name];
  process.send?.({ event: 'dns_lookup', name, addresses });
  return addresses.map(address => ({ address, family: address.includes(':') ? 6 : 4 }));
};

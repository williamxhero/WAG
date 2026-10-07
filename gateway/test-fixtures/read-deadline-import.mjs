// Loaded only by the isolated offline test child via --import. Never imported
// by the gateway and deliberately not controlled by production environment.
import dns from 'node:dns/promises';
import http from 'node:http';

const lookup = dns.lookup.bind(dns);
dns.lookup = (hostname, options) => hostname === 'deadline.fixture.test'
  ? Promise.resolve([{ address: '93.184.216.34', family: 4 }])
  : lookup(hostname, options);

// Exercise the unchanged production deadline at a CI-sized clock scale.
const setTimer = globalThis.setTimeout;
globalThis.setTimeout = (callback, milliseconds, ...args) => setTimer(callback, milliseconds === 30000 ? 350 : milliseconds, ...args);
const request = http.request;
http.request = (options, ...args) => request({ ...options, ...(options.timeout === 30000 ? { timeout: 350 } : {}) }, ...args);

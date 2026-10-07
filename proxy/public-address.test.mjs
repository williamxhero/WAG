import assert from 'node:assert/strict';
import test from 'node:test';
import { isPublicAddress } from './public-address.mjs';

const ipv4Policy = address => address === '8.8.8.8';
test('IPv6 CIDR exclusions cover interiors and exact boundaries without string-prefix gaps', () => {
  for (const address of [
    '2001::1', '2001:0:ffff:ffff:ffff:ffff:ffff:ffff',
    '2001:2::1', '2001:2:0:ffff:ffff:ffff:ffff:ffff',
    '2001:10::1', '2001:1f:ffff:ffff:ffff:ffff:ffff:ffff',
    '2001:20::1', '2001:21::1', '2001:2f:ffff:ffff:ffff:ffff:ffff:ffff',
    '2001:30::1', '2001:3f::1', '2001:db8::1', '2002:ffff::1',
    '3fff::1', '3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff',
    '0:0:0:0:0:0:0:1', 'fc00::1', 'fe80::1', 'ff02::1', 'not-an-ip',
  ]) assert.equal(isPublicAddress(address, ipv4Policy), false, address);
  for (const address of ['2001:1::1', '2001:2:1::1', '2001:40::1', '2001:db9::1', '2606:4700:4700::1111', '3fff:1000::1']) {
    assert.equal(isPublicAddress(address, ipv4Policy), true, address);
  }
});

test('numeric and mapped IPv4 classification delegates the caller policy unchanged', () => {
  for (const address of ['8.8.8.8', '::ffff:8.8.8.8', '0:0:0:0:0:ffff:0808:0808']) {
    assert.equal(isPublicAddress(address, ipv4Policy), true, address);
  }
  for (const address of ['127.0.0.1', '::ffff:127.0.0.1']) {
    assert.equal(isPublicAddress(address, ipv4Policy), false, address);
  }
  assert.equal(isPublicAddress('192.0.10.1', () => true), true);
  assert.equal(isPublicAddress('192.0.10.1', () => false), false);
});

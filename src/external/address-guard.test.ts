import { describe, expect, it } from 'vitest';
import { isForbiddenAddress } from './address-guard.js';

describe('isForbiddenAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    'fe80::1',
    'fd00::1',
    '::ffff:10.0.0.1',
    'ff02::1',
  ])('refuses the brief address %s', (ip) => {
    expect(isForbiddenAddress(ip)).toBe(true);
  });

  it.each([
    // one address inside each forbidden IPv4 range, plus its edges
    ['0.0.0.0/8', '0.255.255.255'],
    ['10/8', '10.0.0.0'],
    ['10/8', '10.255.255.255'],
    ['100.64/10', '100.127.255.255'],
    ['127/8', '127.255.0.1'],
    ['169.254/16', '169.254.0.1'],
    ['172.16/12', '172.31.255.255'],
    ['192.0.0/24', '192.0.0.8'],
    ['192.0.2/24', '192.0.2.10'],
    ['192.168/16', '192.168.255.255'],
    ['198.18/15', '198.18.0.1'],
    ['198.18/15', '198.19.255.255'],
    ['198.51.100/24', '198.51.100.7'],
    ['203.0.113/24', '203.0.113.200'],
    ['224/4', '224.0.0.1'],
    ['224/4', '239.255.255.255'],
    ['240/4', '240.0.0.1'],
    ['255.255.255.255', '255.255.255.255'],
  ])('refuses IPv4 %s (%s)', (_range, ip) => {
    expect(isForbiddenAddress(ip)).toBe(true);
  });

  it.each([
    ['::', '::'],
    ['::1', '0:0:0:0:0:0:0:1'],
    ['fc00::/7', 'fc00::1'],
    ['fc00::/7', 'fdff:ffff::1'],
    ['fe80::/10', 'febf::1'],
    ['ff00::/8', 'ff05::2'],
    ['64:ff9b::/96 embedding 127.0.0.1', '64:ff9b::7f00:1'],
    ['64:ff9b::/96 embedding 10.0.0.1', '64:ff9b::10.0.0.1'],
    ['2001:db8::/32', '2001:db8::1'],
    ['2001:db8::/32', '2001:0db8:ffff::1'],
    ['mapped hex loopback', '::ffff:7f00:1'],
    ['mapped hex metadata', '::ffff:a9fe:a9fe'],
    ['mapped dotted metadata', '::ffff:169.254.169.254'],
    ['mapped upper-case', '::FFFF:7F00:1'],
    ['expanded mapped', '0:0:0:0:0:ffff:7f00:1'],
  ])('refuses IPv6 %s (%s)', (_range, ip) => {
    expect(isForbiddenAddress(ip)).toBe(true);
  });

  it.each(['', 'localhost', 'example.com', '1.2.3', '256.1.1.1', '127.1', '0x7f000001', '2130706433', '[::1]', 'fe80::1%eth0', ' 8.8.8.8'])(
    'refuses %j, which does not parse as an IP',
    (value) => {
      expect(isForbiddenAddress(value)).toBe(true);
    },
  );

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '100.63.255.255', // just below 100.64/10
    '100.128.0.0', // just above 100.64/10
    '172.15.255.255',
    '172.32.0.0',
    '198.17.255.255',
    '198.20.0.0',
    '223.255.255.255',
    '2001:4860:4860::8888',
    '2606:4700:4700::1111',
    '::ffff:8.8.8.8',
    '::ffff:808:808',
    '64:ff9b::808:808',
    '2001:db9::1',
  ])('allows the public address %s', (ip) => {
    expect(isForbiddenAddress(ip)).toBe(false);
  });
});

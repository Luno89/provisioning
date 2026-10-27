import { describe, expect, it } from 'vitest';
import { addressProblem } from './public-address.js';

describe('an address Koala may reach on the open internet', () => {
  it('is public', () => {
    for (const address of ['93.184.216.34', '1.1.1.1', '2606:4700:4700::1111', '[2a00:1450:4001::200e]']) expect(addressProblem(address), address).toBeUndefined();
  });

  it('is never this machine, the private network, the mesh, link-local metadata or a tunnel to them', () => {
    for (const address of [
      '127.0.0.1', '10.0.0.5', '172.16.3.4', '192.168.1.1', '100.64.0.80', '169.254.169.254', '0.0.0.0', '224.0.0.1',
      '::1', '::', 'fe80::1', 'fc00::1', 'fd12::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '2002:0a00:0001::1', '2001:0000:4136::1', '64:ff9b::a00:1',
    ]) expect(addressProblem(address), address).toBeDefined();
  });
});

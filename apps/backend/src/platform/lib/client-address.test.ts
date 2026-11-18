import { describe, expect, it } from 'vitest';
import { trustProxyFrom } from './client-address.js';

describe('who the backend believes the visitor is', () => {
  it('takes the address the one proxy in front of it says, where root\'s Caddy or the pool\'s proxy sets it to the visitor', () => {
    expect(trustProxyFrom('1')).toEqual({ trust: 1 });
  });

  it('on a dev box takes the address Vite\'s proxy on this computer says, and nobody else\'s', () => {
    expect(trustProxyFrom('loopback')).toEqual({ trust: 'loopback' });
  });

  it('is never guessed: a missing or unknown setting says what it may be', () => {
    expect(trustProxyFrom(undefined)).toMatchObject({ problem: /^TRUST_PROXY is not set: it is 1 where one proxy/ });
    expect(trustProxyFrom('2')).toMatchObject({ problem: /^TRUST_PROXY is "2": it is 1 where/ });
  });
});

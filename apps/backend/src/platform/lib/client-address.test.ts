import { describe, expect, it } from 'vitest';
import { trustProxyFor } from './client-address.js';

describe('who the backend believes the visitor is', () => {
  it('in production takes the address the one proxy in front of it says, since root\'s Caddy and the pool\'s proxy each set it to the visitor', () => {
    expect(trustProxyFor({ NODE_ENV: 'production' })).toBe(1);
  });

  it('on a dev box takes the connection\'s own address, since nothing stands in front of it', () => {
    expect(trustProxyFor({})).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { appLabel, edgeSite, flatHost, freeLabel, labelOfFlat, nestedHost } from './edge-addresses.js';

describe('the addresses an instance gives its apps', () => {
  it('makes flat and nested names from the app\'s name', () => {
    expect(appLabel('My Shop!')).toBe('my-shop');
    expect(flatHost('my-shop', 'luno', 'koala.dev')).toBe('my-shop-luno.koala.dev');
    expect(nestedHost('my-shop', 'luno', 'koala.dev')).toBe('my-shop.luno.koala.dev');
    expect(labelOfFlat('my-shop-luno.koala.dev', 'luno', 'koala.dev')).toBe('my-shop');
    expect(labelOfFlat('my-shop.koala.dev', 'luno', 'koala.dev')).toBeUndefined();
  });

  it('gives a second app with the same label a number, and keeps every label inside DNS\'s limit', () => {
    expect(freeLabel('shop', 'luno', new Set())).toBe('shop');
    expect(freeLabel('shop', 'luno', new Set(['shop', 'shop-2']))).toBe('shop-3');
    const long = freeLabel('a'.repeat(80), 'luno', new Set());
    expect(`${long}-luno`.length).toBeLessThanOrEqual(63);
    expect(`${freeLabel('a'.repeat(80), 'luno', new Set([long]))}-luno`.length).toBeLessThanOrEqual(63);
  });

  it('serves every address of an app from one plain-http block, sending the app\'s own host to its cluster', () => {
    const site = edgeSite(['shop-luno.koala.dev', 'shop.luno.koala.dev'], '100.64.0.9:31080', 'shop.apps.local');
    expect(site).toMatch(/^http:\/\/shop-luno\.koala\.dev, http:\/\/shop\.luno\.koala\.dev \{/);
    expect(site).toContain('reverse_proxy 100.64.0.9:31080');
    expect(site).toContain('header_up Host shop.apps.local');
  });
});

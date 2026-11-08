import { describe, expect, it } from 'vitest';
import { addressScope, inScope, offersNested, appLabel, edgeSite, flatHost, freeLabel, labelOfFlat, labelOfLocal, localHost, nestedHost } from './edge-addresses.js';

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
    expect(site).toContain('header_up X-Forwarded-Proto https');
  });

  it('serves an app on this computer at <label>.localhost on the edge\'s local port, as plain http', () => {
    const site = edgeSite([localHost('tabbyapi', 8000)], 'traefik.kube-system.svc.cluster.local:80', 'tabbyapi-ab12cd.apps.local', 'http');
    expect(site).toMatch(/^http:\/\/tabbyapi\.localhost:8000 \{/);
    expect(site).toContain('header_up X-Forwarded-Proto http\n');
  });

  it('reads the label back from a local address only when it is on the same port, so an app keeps the address it had', () => {
    expect(labelOfLocal('http://tabbyapi-production.localhost:8000', 8000)).toBe('tabbyapi-production');
    expect(labelOfLocal('http://tabbyapi-production.localhost:8000/', 8000)).toBe('tabbyapi-production');
    expect(labelOfLocal('http://tabbyapi.localhost:8001', 8000)).toBeUndefined();
    expect(labelOfLocal('https://shop-luno.koala.dev', 8000)).toBeUndefined();
    expect(labelOfLocal(undefined, 8000)).toBeUndefined();
  });
});

describe('whose addresses an app takes', () => {
  it('takes its project\'s group while the project is shared, else the instance\'s name', () => {
    expect(addressScope({ group: 'acme', instance: 'luno' })).toEqual({ kind: 'group', name: 'acme' });
    expect(addressScope({ instance: 'luno' })).toEqual({ kind: 'instance', name: 'luno' });
  });

  it('keeps a stored address only while it belongs to the scope, which is what moves an app when its project is shared or taken back', () => {
    const group = addressScope({ group: 'acme', instance: 'luno' });
    const owner = addressScope({ instance: 'luno' });
    expect(inScope('shop-acme.koala.dev', group, 'koala.dev')).toBe(true);
    expect(inScope('shop-luno.koala.dev', group, 'koala.dev')).toBe(false);
    expect(inScope('shop-acme.koala.dev', owner, 'koala.dev')).toBe(false);
    expect(inScope('shop-luno.koala.dev', owner, 'koala.dev')).toBe(true);
  });

  it('offers nested addresses only under the owner\'s own name, never under a group', () => {
    expect(offersNested(addressScope({ instance: 'luno' }))).toBe(true);
    expect(offersNested(addressScope({ group: 'acme', instance: 'luno' }))).toBe(false);
  });
});

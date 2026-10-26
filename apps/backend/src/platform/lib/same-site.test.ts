import { describe, expect, it } from 'vitest';
import { crossSiteRefusal, foreignOrigin, ourOrigins } from './same-site.js';

const production = ourOrigins({ NODE_ENV: 'production', PUBLIC_URL: 'https://app.nowrinkles.dev' });
const dev = ourOrigins({ APP_URL: 'http://localhost:5173' });

describe('a request that changes something comes from this site', () => {
  it('lets reads through whoever sent them', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'get']) {
      expect(crossSiteRefusal(method, { host: 'app.nowrinkles.dev', origin: 'https://evil.example', fetchSite: 'cross-site' }, production)).toBeUndefined();
    }
  });

  it('takes a write from the page it serves and from its public address', () => {
    expect(crossSiteRefusal('POST', { host: 'app.nowrinkles.dev', origin: 'https://app.nowrinkles.dev', fetchSite: 'same-origin' }, production)).toBeUndefined();
    expect(crossSiteRefusal('DELETE', { host: 'luno.nowrinkles.app', origin: 'https://luno.nowrinkles.app', fetchSite: 'same-origin' }, production)).toBeUndefined();
    expect(crossSiteRefusal('PUT', { host: '127.0.0.1:3001', origin: 'https://app.nowrinkles.dev' }, production)).toBeUndefined();
  });

  it('refuses a write from a sibling site under the same domain, the attack a second domain and this both close', () => {
    expect(crossSiteRefusal('POST', { host: 'luno.nowrinkles.app', origin: 'https://shop-mallory.nowrinkles.app', fetchSite: 'same-site' }, production)).toMatch(/shop-mallory\.nowrinkles\.app, which is not this site/);
    expect(crossSiteRefusal('POST', { host: 'app.nowrinkles.dev', origin: 'https://evil.example', fetchSite: 'cross-site' }, production)).toMatch(/not this site/);
  });

  it('refuses a write from a page with no origin, such as a sandboxed file', () => {
    expect(crossSiteRefusal('POST', { host: 'app.nowrinkles.dev', origin: 'null' }, production)).toMatch(/no origin/);
  });

  it('refuses a browser write that says it came from elsewhere even without an origin', () => {
    expect(crossSiteRefusal('POST', { host: 'app.nowrinkles.dev', fetchSite: 'same-site' }, production)).toMatch(/another site/);
    expect(crossSiteRefusal('POST', { host: 'app.nowrinkles.dev', fetchSite: 'same-origin' }, production)).toBeUndefined();
    expect(crossSiteRefusal('POST', { host: 'app.nowrinkles.dev', fetchSite: 'none' }, production)).toBeUndefined();
  });

  it('takes a write from a program, which sends neither, like a machine, an instance or a webhook', () => {
    expect(crossSiteRefusal('POST', { host: 'app.nowrinkles.dev' }, production)).toBeUndefined();
  });

  it('takes the dev page on another loopback port, and no loopback page in production', () => {
    expect(crossSiteRefusal('POST', { host: 'localhost:3001', origin: 'http://localhost:5173', fetchSite: 'same-site' }, dev)).toBeUndefined();
    expect(crossSiteRefusal('POST', { host: 'localhost:3001', origin: 'http://koala.localhost:5175', fetchSite: 'cross-site' }, dev)).toBeUndefined();
    expect(crossSiteRefusal('POST', { host: 'localhost:3001', origin: 'http://localhost:5174' }, production)).toMatch(/not this site/);
    expect(crossSiteRefusal('POST', { host: 'localhost:3001', origin: 'https://evil.example' }, dev)).toMatch(/not this site/);
  });

  it('applies the same rule to a socket, whose handshake is a read', () => {
    expect(foreignOrigin({ host: 'luno.nowrinkles.app', origin: 'https://shop-mallory.nowrinkles.app' }, production)).toMatch(/not this site/);
    expect(foreignOrigin({ host: 'luno.nowrinkles.app', origin: 'https://luno.nowrinkles.app' }, production)).toBeUndefined();
    expect(foreignOrigin({ host: 'app.nowrinkles.dev' }, production)).toBeUndefined();
  });

  it('compares hosts without case and ignores an origin that is not an address', () => {
    expect(crossSiteRefusal('POST', { host: 'App.NoWrinkles.dev', origin: 'https://app.nowrinkles.dev' }, production)).toBeUndefined();
    expect(crossSiteRefusal('POST', { host: 'app.nowrinkles.dev', origin: 'garbage' }, production)).toMatch(/not an address/);
  });
});

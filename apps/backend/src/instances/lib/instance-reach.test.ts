import { describe, expect, it } from 'vitest';
import { instanceOrigin, reachOf, reachSettingsFrom } from './instance-reach.js';

const strict = { open: false, domain: 'nowrinkles.app' };
const at = (raw: string): URL => new URL(raw);

describe('how root reaches an instance', () => {
  it('calls anything outside production, and in a lab', () => {
    expect(reachSettingsFrom({}, false)).toEqual({ open: true, domain: undefined });
    expect(reachSettingsFrom({ NODE_ENV: 'production', INGRESS_DOMAIN: 'nowrinkles.app' }, false)).toEqual({ ...strict, ownCaddy: { host: '127.0.0.1', port: 443 } });
    expect(reachSettingsFrom({ NODE_ENV: 'production' }, true).open).toBe(true);
    expect(reachOf(at('http://127.0.0.1:3001'), {}, { open: true })).toBe('open');
  });

  it('in production calls the instance\'s own mesh address and the address root gave it directly, and anything else only on the open internet', () => {
    const luno = { name: 'luno', meshIp: '100.64.0.7' };
    expect(reachOf(at('http://100.64.0.7:30320'), luno, strict)).toBe('mesh');
    expect(reachOf(at('https://luno.nowrinkles.app'), luno, strict)).toBe('assigned');
    expect(reachOf(at('http://luno.nowrinkles.app'), luno, strict)).toBe('public');
    expect(reachOf(at('https://other.nowrinkles.app'), luno, strict)).toBe('public');
    expect(reachOf(at('http://100.64.0.8:30320'), luno, strict)).toBe('public');
    expect(reachOf(at('http://127.0.0.1:3001'), luno, strict)).toBe('public');
  });

  it('takes only an http or https origin, with no name or password in it', () => {
    expect(instanceOrigin('https://luno.nowrinkles.app/some/path?x=1')).toEqual({ origin: new URL('https://luno.nowrinkles.app') });
    for (const raw of ['javascript:alert(1)', 'file:///etc/passwd', 'not a url', 'https://a:b@luno.nowrinkles.app']) {
      expect(instanceOrigin(raw), raw).toHaveProperty('problem');
    }
  });
});

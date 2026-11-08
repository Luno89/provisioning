import { describe, expect, it } from 'vitest';
import { missingSettings, notSetProblem, settingHostPort, settingUrl } from './setting-urls.js';

describe('which settings are missing', () => {
  it('names each one unset, empty or only spaces, in the order asked', () => {
    expect(missingSettings({ A: 'a', B: '', C: '   ', E: 'e' }, ['A', 'B', 'C', 'D', 'E'])).toEqual(['B', 'C', 'D']);
    expect(missingSettings({ A: 'a' }, ['A'])).toEqual([]);
    expect(missingSettings({}, [])).toEqual([]);
  });

  it('says one is not set, and several are not set', () => {
    expect(notSetProblem('Gitea is not set up', ['GITEA_URL'], 'the chart sets it')).toBe('Gitea is not set up: GITEA_URL is not set; the chart sets it');
    expect(notSetProblem('Gitea is not set up', ['GITEA_URL', 'GITEA_REACHES_KOALA_AT'], 'the chart sets both')).toBe('Gitea is not set up: GITEA_URL, GITEA_REACHES_KOALA_AT are not set; the chart sets both');
  });
});

describe('a service\'s address', () => {
  it('is taken as its scheme, host and port, trimmed, with a trailing slash dropped', () => {
    expect(settingUrl('X', 'http://gitea-http.gitea.svc.cluster.local:3000')).toBe('http://gitea-http.gitea.svc.cluster.local:3000');
    expect(settingUrl('X', '  http://127.0.0.1:31737/  ')).toBe('http://127.0.0.1:31737');
    expect(settingUrl('X', 'https://vault.example.com//')).toBe('https://vault.example.com');
    expect(settingUrl('X', 'http://[::1]:8080')).toBe('http://[::1]:8080');
  });

  it('is the lowest and highest port there are', () => {
    expect(settingUrl('X', 'http://h:1')).toBe('http://h:1');
    expect(settingUrl('X', 'http://h:65535')).toBe('http://h:65535');
  });

  it.each([
    ['gitea-http:3000', 'X is not an http or https address: gitea-http:3000'],
    ['127.0.0.1:31737', 'X is not an address: 127.0.0.1:31737'],
    ['not an address', 'X is not an address: not an address'],
    ['http://', 'X is not an address: http://'],
    ['http://h:65536', 'X is not an address: http://h:65536'],
    ['ftp://h:21', 'X is not an http or https address: ftp://h:21'],
    ['file:///tmp/repo', 'X is not an http or https address: file:///tmp/repo'],
    ['http://h:3000/api', 'X has a path, and is the service\'s own address: http://h:3000/api'],
    ['http://h:3000?a=1', 'X carries a query or a fragment, which nothing appends to: http://h:3000?a=1'],
    ['http://h:3000/#x', 'X carries a query or a fragment, which nothing appends to: http://h:3000/#x'],
  ])('refuses %s', (value, said) => {
    expect(() => settingUrl('X', value)).toThrow(said);
  });

  it('refuses a sign-in in the address without repeating it', () => {
    expect(() => settingUrl('X', 'http://bot:s3cret@h:3000')).toThrow('X names a sign-in, which is never kept in an address: http://…@h:3000');
    try { settingUrl('X', 'http://bot:s3cret@h:3000'); } catch (err) { expect((err as Error).message).not.toContain('s3cret'); }
  });
});

describe('a host and port', () => {
  it('is taken as given, trimmed', () => {
    expect(settingHostPort('X', ' 127.0.0.1:31737 ')).toBe('127.0.0.1:31737');
    expect(settingHostPort('X', 'gitea-http.gitea.svc.cluster.local:3000')).toBe('gitea-http.gitea.svc.cluster.local:3000');
    expect(settingHostPort('X', 'h:1')).toBe('h:1');
    expect(settingHostPort('X', 'h:65535')).toBe('h:65535');
  });

  it.each(['127.0.0.1', ':5000', 'h:', 'h:0', 'h:65536', 'h:50a0', 'h:-1', 'http://h:5000', 'a b:5000', 'u@h:5000'])('refuses %s', (value) => {
    expect(() => settingHostPort('X', value)).toThrow(`X is not a host and port: ${value}`);
  });
});

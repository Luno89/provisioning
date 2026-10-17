import { describe, expect, it } from 'vitest';
import { certificateCovers, instanceRouteFiles, issuingProblem, wantedRoutes } from './instance-routes.js';

describe('instance routes', () => {
  it('sends the person\'s own address to their backend and their flat app addresses to their edge', () => {
    const { handles, site } = instanceRouteFiles({ name: 'luno', meshIp: '100.64.0.7', nested: false }, 'koala.dev');
    expect(handles).toContain('@instance_luno host luno.koala.dev');
    expect(handles).toContain('reverse_proxy 100.64.0.7:30320');
    expect(handles).toContain('@apps_luno header_regexp Host ^[a-z0-9-]+-luno\\.koala\\.dev$');
    expect(handles).toContain('reverse_proxy 100.64.0.7:30321');
    expect(handles).toContain('read_timeout 0');
    expect(site).toBeNull();
  });

  it('gives nested addresses a site of their own, with its own certificate', () => {
    const { site } = instanceRouteFiles({ name: 'luno', meshIp: '100.64.0.7', nested: true }, 'koala.dev');
    expect(site).toMatch(/^\*\.luno\.koala\.dev \{/);
    expect(site).toContain('import koala_tls');
    expect(site).toContain('reverse_proxy 100.64.0.7:30321');
  });

  it('refuses an upstream that is not on the mesh', () => {
    expect(() => instanceRouteFiles({ name: 'luno', meshIp: '10.0.0.1', nested: false }, 'koala.dev')).toThrow(/not a mesh address/);
    expect(() => instanceRouteFiles({ name: 'luno', meshIp: '100.64.0.7 { }', nested: false }, 'koala.dev')).toThrow(/not a mesh address/);
  });
});

describe('the routes root wants', () => {
  it('routes only ready instances with a name and a mesh address', () => {
    const wanted = wantedRoutes([
      { name: 'luno', meshIp: '100.64.0.7', status: 'ready', addresses: { nested: true } },
      { name: 'sam', meshIp: '100.64.0.8', status: 'installing' },
      { name: 'kim', status: 'ready' },
      { meshIp: '100.64.0.9', status: 'ready' },
    ], 'koala.dev');
    expect([...wanted.handles.keys()]).toEqual(['luno.caddy']);
    expect([...wanted.sites.keys()]).toEqual(['luno.caddy']);
  });

  it('knows when the nested certificate is served', () => {
    expect(certificateCovers('DNS:*.luno.koala.dev', 'luno', 'koala.dev')).toBe(true);
    expect(certificateCovers('DNS:*.koala.dev, DNS:koala.dev', 'luno', 'koala.dev')).toBe(false);
    expect(certificateCovers(undefined, 'luno', 'koala.dev')).toBe(false);
  });

  it('says why a certificate is not issued yet, from Caddy\'s log', () => {
    const log = [
      JSON.stringify({ level: 'info', msg: 'obtaining certificate', identifier: '*.luno.koala.dev' }),
      JSON.stringify({ level: 'error', identifier: '*.luno.koala.dev', error: 'HTTP 429 urn:ietf:params:acme:error:rateLimited - too many certificates already issued' }),
      JSON.stringify({ level: 'error', identifier: '*.sam.koala.dev', error: 'other' }),
    ].join('\n');
    expect(issuingProblem(log, 'luno', 'koala.dev')).toMatch(/weekly limit/);
    expect(issuingProblem(log, 'kim', 'koala.dev')).toBeUndefined();
  });
});

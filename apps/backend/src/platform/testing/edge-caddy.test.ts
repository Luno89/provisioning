import { describe, expect, it } from 'vitest';
import { certificatesIn, coversHost } from './edge-caddy.js';

describe('which certificates a test Caddy holds', () => {
  it('reads the names Caddy obtained a certificate for from its log, and nothing it only began obtaining or has not finished writing', () => {
    const log = [
      '{"level":"info","logger":"tls.obtain","msg":"obtaining certificate","identifier":"koala.localhost"}',
      '{"level":"info","logger":"tls.obtain","msg":"certificate obtained successfully","identifier":"mesh.localhost","issuer":"local"}',
      'not a line Caddy wrote, certificate obtained successfully',
      '{"level":"info","logger":"tls.obtain","msg":"certificate obtained successfully","identifier":"*.apps.localhost","issuer":"local"}',
      '{"level":"info","logger":"tls.obtain","msg":"certificate obtained successfully","identifier":"half.wri',
    ].join('\n');
    expect(certificatesIn(log)).toEqual(['mesh.localhost', '*.apps.localhost']);
  });

  it('takes a wildcard as covering one label under it, and a plain name only itself', () => {
    expect(coversHost('*.apps.localhost', 'luno.apps.localhost')).toBe(true);
    expect(coversHost('*.apps.localhost', 'a.luno.apps.localhost')).toBe(false);
    expect(coversHost('*.apps.localhost', 'apps.localhost')).toBe(false);
    expect(coversHost('koala.localhost', 'koala.localhost')).toBe(true);
    expect(coversHost('koala.localhost', 'mesh.localhost')).toBe(false);
  });
});

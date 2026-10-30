import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { temporalTls, temporalTlsProblem } from './temporal-tls.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const caFile = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'temporal-tls-'));
  dirs.push(dir);
  const file = join(dir, 'ca.crt');
  writeFileSync(file, 'a certificate authority');
  return file;
};

describe('the connection to Temporal', () => {
  it('trusts the CA it is pointed at', () => {
    const file = caFile();
    expect(temporalTls({ TEMPORAL_TLS_CA: file, NODE_ENV: 'production' })).toEqual({ serverRootCACertificate: Buffer.from('a certificate authority') });
    expect(temporalTlsProblem({ TEMPORAL_TLS_CA: file, NODE_ENV: 'production' })).toBeUndefined();
  });

  it('in production refuses to go without its CA rather than talking plaintext, and says where it looked', () => {
    const env = { TEMPORAL_TLS_CA: '/nowhere/ca.crt', NODE_ENV: 'production' };
    expect(temporalTlsProblem(env)).toMatch(/^Temporal's certificate authority is not at \/nowhere\/ca\.crt \(TEMPORAL_TLS_CA\)\. In production Koala never talks to Temporal in plaintext/);
    expect(() => temporalTls(env)).toThrow(/never talks to Temporal in plaintext/);
  });

  it('on a dev box without a CA still connects as before', () => {
    expect(temporalTlsProblem({ TEMPORAL_TLS_CA: '/nowhere/ca.crt' })).toBeUndefined();
    expect(temporalTls({ TEMPORAL_TLS_CA: '/nowhere/ca.crt' })).toBe(false);
  });
});

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
    expect(temporalTls({ caPath: file })).toEqual({ serverRootCACertificate: Buffer.from('a certificate authority') });
    expect(temporalTlsProblem({ caPath: file })).toBeUndefined();
  });

  it('refuses to connect without its CA wherever it runs, and says where it looked', () => {
    for (const NODE_ENV of ['production', 'development', 'test', undefined]) {
      const place = { caPath: '/nowhere/ca.crt', NODE_ENV } as { caPath: string };
      expect(temporalTlsProblem(place), String(NODE_ENV)).toMatch(/^Temporal's certificate authority is not at \/nowhere\/ca\.crt \(TEMPORAL_TLS_CA\)\. Koala never talks to Temporal in plaintext/);
      expect(() => temporalTls(place), String(NODE_ENV)).toThrow(/never talks to Temporal in plaintext/);
    }
  });
});

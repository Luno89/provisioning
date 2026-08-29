import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildAppEnv, type AppEnvArgs } from './app-env.js';

const here = dirname(fileURLToPath(import.meta.url));

const SENTINEL = (name: string) => `SENTINEL_${name}`;

function declaredStringFields(): string[] {
  const src = readFileSync(join(here, 'app-env.ts'), 'utf8');
  const iface = src.slice(src.indexOf('export interface AppEnvArgs'), src.indexOf('\n}', src.indexOf('export interface AppEnvArgs')));
  return [...iface.matchAll(/^\s{2}([a-zA-Z][A-Za-z0-9]*)\?:\s*string\s*\|\s*undefined;/gm)].map((m) => m[1]!);
}

const base: AppEnvArgs = {
  physicalName: 'c', strategy: 'native', sanitizedName: 'app', deploymentId: 'd1',
  kubeconfigPath: '/tmp/k', provider: 'k3d', isMock: false, appType: 'gitapp',
  vllmGpuCount: 0, tabbyGpuCount: 0, vllmDevice: 'cpu', storageEnv: {},
};

describe('a setting reaching the container', () => {
  it('carries every declared string field into the env', () => {
    const fields = declaredStringFields();
    expect(fields.length).toBeGreaterThan(20);

    const args = { ...base } as Record<string, unknown>;
    for (const f of fields) args[f] = SENTINEL(f);
    const env = buildAppEnv(args as unknown as AppEnvArgs);
    const values = new Set(Object.values(env));

    const missing = fields.filter((f) => !values.has(SENTINEL(f)));
    expect(missing, `these fields never reach the container: ${missing.join(', ')}`).toEqual([]);
  });

  it('carries the fields the measured bugs were about', () => {
    const env = buildAppEnv({
      ...base,
      gitappEnv: 'GITHUB_TOKEN=abc',
      minioRootPassword: 'pw',
      quickwitS3SecretKey: 'sk',
      verdaccioUpstream: 'https://registry.npmjs.org/',
    });
    expect(env.GITAPP_ENV).toBe('GITHUB_TOKEN=abc');
    expect(env.MINIO_ROOT_PASSWORD).toBe('pw');
    expect(env.QUICKWIT_S3_SECRET_KEY).toBe('sk');
    expect(env.VERDACCIO_UPSTREAM).toBe('https://registry.npmjs.org/');
  });

  it('does not invent values for fields that were not set', () => {
    const env = buildAppEnv(base);
    expect(env.GITAPP_ENV).toBe('');
    expect(env.MINIO_ROOT_PASSWORD).toBe('');
  });
});

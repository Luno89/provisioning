import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildAppEnv, FOLDED_SETTINGS, modelHfToken, type AppEnvArgs } from './app-env.js';
import { APP_SETTINGS } from './deploy-request.js';

const here = dirname(fileURLToPath(import.meta.url));

const SENTINEL = (name: string) => `SENTINEL_${name}`;

function declaredStringFields(): string[] {
  const src = readFileSync(join(here, 'app-env.ts'), 'utf8');
  const iface = src.slice(src.indexOf('export interface AppEnvArgs'), src.indexOf('\n}', src.indexOf('export interface AppEnvArgs')));
  const own = [...iface.matchAll(/^\s{2}([a-zA-Z][A-Za-z0-9]*)\?:\s*string\s*\|\s*undefined;/gm)].map((m) => m[1]!);
  const folded: readonly string[] = FOLDED_SETTINGS;
  const settings = Object.entries(APP_SETTINGS).filter(([name, kind]) => (kind === 'text' || Array.isArray(kind)) && !folded.includes(name)).map(([name]) => name);
  return [...own, ...settings];
}

const base: AppEnvArgs = {
  physicalName: 'c', strategy: 'native', namespace: 'app', deploymentId: 'd1',
  kubeconfigPath: '/tmp/k', serviceType: 'NodePort', appType: 'gitapp',
  vllmGpuCount: 0, tabbyGpuCount: 0, storageEnv: {},
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

  it('hands a model its own Hugging Face token under the one name the stack reads, and none to an app without one', () => {
    expect(buildAppEnv({ ...base, appType: 'vllm', hfToken: modelHfToken({ appType: 'vllm', vllmHfToken: 'theirs', tabbyHfToken: 'other' }) }).HF_TOKEN).toBe('theirs');
    expect(buildAppEnv({ ...base, appType: 'tabbyapi', hfToken: modelHfToken({ appType: 'tabbyapi', vllmHfToken: 'other', tabbyHfToken: 'theirs' }) }).HF_TOKEN).toBe('theirs');
    expect(modelHfToken({ appType: 'gitapp', vllmHfToken: 'stray', tabbyHfToken: 'stray' })).toBeUndefined();
    const env = buildAppEnv({ ...base, appType: 'vllm' });
    expect(env.HF_TOKEN).toBe('');
    expect(Object.keys(env).filter((name) => /HF_TOKEN|HUGGING_FACE/.test(name))).toEqual(['HF_TOKEN']);
  });

  it('does not invent values for fields that were not set', () => {
    const env = buildAppEnv(base);
    expect(env.GITAPP_ENV).toBe('');
    expect(env.MINIO_ROOT_PASSWORD).toBe('');
  });
});

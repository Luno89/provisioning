import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildAppEnv, type AppEnvArgs } from './app-env.js';

/**
 * Does a setting actually reach the container?
 *
 * ── WHY THIS EXISTS, WRITTEN AFTER THE FACT ──
 * Every unit test in this codebase passed while the bugs that mattered shipped. They were all the
 * same shape: a field added to one layer and not the next, in a chain nobody tests end to end —
 * request config → deployment record → workflow arguments → env map → CDKTF construct → pod.
 *
 * Measured failures of exactly that shape:
 *   - `gitappEnv` was added to five places and still never reached a container, because the sixth
 *     (config → record, for an EXISTING deployment) was missed. The deployed app had no
 *     environment at all and crash-looped.
 *   - `webRepo`/`webTag` were only ever set for a NEW record, so every redeploy of every app type
 *     ran the first image it had ever been given. The record showed the new tag; the pod served
 *     the old one.
 *   - `PORT` was never injected at all, so an app reading process.env.PORT exited immediately.
 *
 * A test asserting `buildAppEnv({ gitappEnv: 'X' }).GITAPP_ENV === 'X'` would have caught none of
 * them — it asserts the line you just wrote. These walk the seam instead, and the reflective one
 * fails for a field that does not exist yet, which is the only kind of test that catches the NEXT
 * omission rather than the last one.
 */

const here = dirname(fileURLToPath(import.meta.url));

/** A sentinel per field, so a value appearing in the output can be traced back to its source. */
const SENTINEL = (name: string) => `SENTINEL_${name}`;

/**
 * Every optional string field on AppEnvArgs, read from the source.
 *
 * From the FILE rather than a hand-written list, because a hand-written list is one more thing to
 * forget to update — which is the very failure being tested for.
 */
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
    /**
     * The reflective one. Any `foo?: string | undefined` on AppEnvArgs must appear in the built
     * env, so adding a field and forgetting the map fails HERE rather than in a cluster three
     * hours later.
     */
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
    // Named explicitly as well, so the reason these exist survives someone rewriting the reflective
    // test above.
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
    // The other direction: an unset field must arrive empty, not carrying the last deployment's
    // value or a construct default that nobody chose.
    const env = buildAppEnv(base);
    expect(env.GITAPP_ENV).toBe('');
    expect(env.MINIO_ROOT_PASSWORD).toBe('');
  });
});

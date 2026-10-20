import { describe, it, expect, afterEach } from 'vitest';
import axios from 'axios';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundleAsEnv, instancesRouter } from './instances.js';
import { mountRouter, TEST_USER, type Harness } from './test-harness.js';
import { InstanceService } from '../services/InstanceService.js';

describe('what the installer sources', () => {
  it('reads back every value exactly in a POSIX shell, whatever characters it holds', () => {
    const bundle = {
      instanceId: 'inst-1', ownerId: 'u1', rootUrl: 'https://app.example.com', rootPublicKeys: "-----BEGIN PUBLIC KEY-----\nab'c$(rm -rf /)\n-----END PUBLIC KEY-----",
      meshLoginServer: 'https://mesh.example.com', preAuthKey: "key'with`quotes`", registry: '100.64.0.1:5001', image: '100.64.0.1:5001/nowrinkles/app',
      imageTag: 'abc', chartUrl: 'https://app.example.com/api/instances/chart.tgz', credential: 'c$HOME', name: 'luno', domain: 'example.com',
    };
    const dir = mkdtempSync(join(tmpdir(), 'bundle-'));
    writeFileSync(join(dir, 'join.env'), bundleAsEnv(bundle));

    const out = execFileSync('sh', ['-c', '. ./join.env; printf "%s\\n%s\\n%s" "$MESH_PREAUTH_KEY" "$INSTANCE_CREDENTIAL" "$(printf "%s" "$ROOT_PUBLIC_KEYS_B64" | base64 -d)"'], { cwd: dir, encoding: 'utf8' });

    expect(out.split('\n').slice(0, 2)).toEqual([bundle.preAuthKey, bundle.credential]);
    expect(out.split('\n').slice(2).join('\n')).toBe(bundle.rootPublicKeys);
  });
});

describe('trying Koala on its own servers', () => {
  let harness: Harness | undefined;
  afterEach(async () => { await harness?.close(); });

  it('offers the pool to someone signed in, and starts their trial instance under the name they pick', async () => {
    const started: string[] = [];
    harness = await mountRouter({
      prefix: '/api/instances',
      user: TEST_USER,
      router: (db) => instancesRouter({
        instances: new InstanceService(db, {
          rootUrl: 'https://app.koala.dev', rootPublicKeys: () => ['PEM'], registry: 'r', imageTag: 't', chartVersion: '1', domain: 'koala.dev',
          pool: { slots: 1, trialDays: 14 },
        }, undefined, () => new Date('2026-10-20T00:00:00Z'), () => {}, async (instanceId) => { started.push(instanceId); }),
        chart: async () => '',
      }),
    });
    const call = (method: 'get' | 'post', path: string, data?: unknown) => axios.request({ method, url: harness!.url(path), data, validateStatus: () => true });

    expect((await call('get', '/api/instances/pool')).data).toEqual({ available: true, trialDays: 14 });
    expect((await call('post', '/api/instances/pool', { name: 'no-dashes' })).status).toBe(400);
    const made = await call('post', '/api/instances/pool', { name: 'alice' });
    expect(made.status).toBe(202);
    expect(made.data).toMatchObject({ name: 'alice', trialEndsAt: '2026-11-03T00:00:00.000Z' });
    expect(started).toHaveLength(1);
    expect((await call('get', '/api/instances/mine')).data.instance).toMatchObject({ status: 'installing', name: 'alice', trialEndsAt: '2026-11-03T00:00:00.000Z' });
  });
});

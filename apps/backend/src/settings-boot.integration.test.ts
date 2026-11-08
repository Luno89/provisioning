import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const BACKEND = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TSX = resolve(BACKEND, '../../node_modules/.bin/tsx');
const homes: string[] = [];

afterAll(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

const rootKey = Buffer.from(String(generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }))).toString('base64');

const CONNECTION = {
  NODE_ENV: 'development',
  JWT_SECRET: 'a-boot-test-secret-of-at-least-thirty-two-chars',
  MONGO_URI: 'mongodb://admin:admin@127.0.0.1:1/provisioning?authSource=admin',
  TEMPORAL_CONNECTION_ADDRESS: '127.0.0.1:1',
  TEMPORAL_NAMESPACE: 'default',
  TEMPORAL_TLS_CA: '/nowhere/ca.crt',
};

const BACKEND_PLACE = { PORT: '0', PUBLIC_URL: 'http://127.0.0.1:1', APP_URL: 'http://127.0.0.1:1' };

const INSTANCE = {
  ...CONNECTION, ROLE: 'instance', INSTANCE_ID: 'inst-1', INSTANCE_OWNER_ID: 'owner-1', ROOT_URL: 'http://127.0.0.1:1', ROOT_PUBLIC_KEYS: rootKey, INSTANCE_CREDENTIAL: 'cred',
  GITEA_URL: 'http://127.0.0.1:1', GITEA_REACHES_KOALA_AT: 'http://127.0.0.1:1', INFISICAL_URL: 'http://127.0.0.1:1',
  MINIO_ENDPOINT: '127.0.0.1:1', MINIO_ROOT_USER: 'koala', MINIO_ROOT_PASSWORD: 'koala-secret', MINIO_BUCKET: 'koala',
  KOALA_REGISTRY: '127.0.0.1:1', KOALA_REGISTRY_PUSH: '127.0.0.1:1', REGISTRY_PULL_HOST: '127.0.0.1:1',
  SEARXNG_URL: 'http://127.0.0.1:1', CRAWL4AI_URL: 'http://127.0.0.1:1', CHECKS_API_URL: 'http://127.0.0.1:1/api', TERRAFORM_STATE: 'local',
};

async function stopsAt(entry: string, env: Record<string, string>): Promise<{ code: number | null; said: string }> {
  const home = await mkdtemp(join(tmpdir(), 'koala-settings-boot-'));
  homes.push(home);
  return new Promise((done, failed) => {
    const child = spawn(TSX, [join(BACKEND, entry)], { cwd: home, env: { PATH: process.env.PATH ?? '', HOME: home, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let said = '';
    child.stdout.on('data', (chunk: Buffer) => { said += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { said += chunk.toString('utf8'); });
    child.on('error', failed);
    child.on('exit', (code) => done({ code, said }));
  });
}

describe('a process started without a setting its role requires', () => {
  it('stops: root\'s backend names what it lacks', async () => {
    const { code, said } = await stopsAt('src/index.ts', { ...CONNECTION, ...BACKEND_PLACE, ROLE: 'root', TERRAFORM_STATE: 'local', INSTANCE_REGISTRY: '127.0.0.1:1' });
    expect(code).toBe(1);
    expect(said).toContain('the backend cannot start; its settings are not right:');
    expect(said).toContain('INSTANCE_IMAGE_TAG is not set');
  });

  it('stops: an instance\'s backend names what it lacks', async () => {
    const { code, said } = await stopsAt('src/index.ts', { ...INSTANCE, ...BACKEND_PLACE });
    expect(code).toBe(1);
    expect(said).toContain('MACHINE_GATEWAY_PORT is not set');
  });

  it('stops: the hub names what it lacks', async () => {
    const { code, said } = await stopsAt('src/index.ts', { ...CONNECTION, ...BACKEND_PLACE, ROLE: 'hub', ROOT_URL: 'http://127.0.0.1:1', ROOT_PUBLIC_KEYS: rootKey, HUB_CREDENTIAL: 'hub', GITEA_URL: 'http://127.0.0.1:1', GITEA_REACHES_KOALA_AT: 'http://127.0.0.1:1' });
    expect(code).toBe(1);
    expect(said).toContain('HUB_DATABASE is not set');
  });

  it('stops: each worker names what it lacks', async () => {
    const host = await stopsAt('src/worker-host.ts', { ...INSTANCE, TEMPORAL_METRICS_PORT: '0' });
    expect(host.code).toBe(1);
    expect(host.said).toContain('the host worker cannot start');
    expect(host.said).toContain('HEALTH_PORT is not set');
    const cluster = await stopsAt('src/worker-cluster.ts', { ...INSTANCE, HEALTH_PORT: '0', TEMPORAL_METRICS_PORT: '0', TERRAFORM_STATE: '' });
    expect(cluster.code).toBe(1);
    expect(cluster.said).toContain('TERRAFORM_STATE is not set');
    const engine = await stopsAt('src/worker-engine.ts', { ...INSTANCE, HEALTH_PORT: '0', CHECKS_API_URL: '' });
    expect(engine.code).toBe(1);
    expect(engine.said).toContain('TEMPORAL_ENGINE_METRICS_PORT is not set');
    expect(engine.said).toContain('CHECKS_API_URL is not set');
  });
}, 300_000);

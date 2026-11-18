import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnScript } from '../coupling/shell-trace.js';
import { readEnvFile } from '../../scripts/root-node/root-env.js';
import { backendSettingsFrom, hostWorkerSettingsFrom } from '../../apps/backend/src/platform/lib/settings.js';

const HELPER = new URL('../../scripts/root-node/root-settings.sh', import.meta.url).pathname;
const dirs: string[] = [];
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'koala-root-settings-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const key = (): string => 'k'.repeat(64);

const ensure = (dir: string, file: string, repo: string, compose: string) => {
  const wrapper = join(dir, 'ensure.sh');
  writeFileSync(wrapper, `#!/usr/bin/env bash\n. "${HELPER}"\nensure_root_settings "$@"\n`);
  return spawnScript(wrapper, [file, repo, compose], { encoding: 'utf8' });
};

const bootstrapWrote = (identity: string): string => [
  'NODE_ENV=production',
  ...['SESSION_KEY', 'DATA_KEY', 'PAYLOAD_KEY', 'EGRESS_KEY', 'TEMPORAL_KEY'].map((name) => `${name}=${key()}`),
  `ROOT_IDENTITY_KEY=${identity}`,
  'ROLE=root',
  'ADMIN_SETUP_CODE=setup',
  'MONGO_URI=mongodb://admin:secret@127.0.0.1:27017/provisioning?authSource=admin',
  'MESH_LOGIN_SERVER=https://mesh.koala.dev',
  'INGRESS_DOMAIN=nowrinkles.app',
  'PUBLIC_URL=https://app.koala.dev',
  'MAIL_SMTP_URL=smtp://127.0.0.1:2525',
  'MAIL_FROM=alerts@koala.dev',
  'HEADSCALE_API_KEY=headscale-key',
  'INSTANCE_REGISTRY=100.64.0.1:5001',
  'POOL_SLOTS=2',
  'POOL_SLOT_MEMORY_MIB=10240',
  'POOL_ADDRESS=100.64.0.1',
  'POOL_IMAGE=127.0.0.1:5000/nowrinkles/app',
  '',
].join('\n');

const UNIT = { CADDY_ADMIN_SOCKET: '/run/koala-caddy/admin.sock', CADDY_LOG: '/var/log/koala-caddy/caddy.log', CADDY_CONFIG: '/opt/nowrinkles/Caddyfile', CADDY_TLS_ADDRESS: '127.0.0.1:443', POOL_KUBECONFIG: '/etc/koala/pool-backend-kubeconfig' };

describe('the settings root keeps in its env file', () => {
  it('are completed by bootstrap and update to everything root\'s backend and host worker require, without changing one already there', () => {
    const repo = scratch();
    execFileSync('git', ['init', '-q', repo]);
    execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'root']);
    const commit = execFileSync('git', ['-C', repo, 'rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8' }).trim();
    const file = join(repo, 'backend.env');
    const compose = join(repo, 'compose.env');
    const identity = Buffer.from(String(generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }))).toString('base64');
    writeFileSync(file, `${bootstrapWrote(identity)}PORT=4000\n`);
    writeFileSync(compose, 'MAIL_RELAYHOST=[smtp.relay.example]:587\n');

    const ran = ensure(repo, file, repo, compose);
    expect(ran.status, ran.stderr).toBe(0);
    const env: Record<string, string> = { ...readEnvFile(file), ...UNIT };
    expect(env.PORT).toBe('4000');
    expect(env).toMatchObject({ APP_URL: 'https://app.koala.dev', INSTANCE_IMAGE_TAG: commit, TEMPORAL_TLS_CA: `${repo}/apps/backend/data/temporal-tls/ca.crt`, MAIL_RELAYHOST: '[smtp.relay.example]:587' });

    const backend = backendSettingsFrom(env);
    expect(env.TRUST_PROXY).toBe('1');
    expect(backend).toMatchObject({ port: 4000, production: true, trustProxy: 1, terraform: { kind: 'local' }, mesh: { loginServer: 'https://mesh.koala.dev', headscaleUrl: 'http://127.0.0.1:8080', headscaleApiKey: 'headscale-key' } });
    expect(backend.root).toMatchObject({ imageTag: commit, routing: { domain: 'nowrinkles.app' }, pool: { slots: 2, slot: { cpu: 4, storageGiB: 100, memoryMiB: 10240 }, trialDays: 14 }, mailReputation: { domain: 'koala.dev', relayhost: '[smtp.relay.example]:587' } });
    expect(hostWorkerSettingsFrom(env)).toMatchObject({ healthPort: 0, temporalMetricsPort: 9465, publicUrl: 'https://app.koala.dev', root: { imageTag: commit } });

    const before = readFileSync(file, 'utf8');
    expect(ensure(repo, file, repo, compose).status).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('refuses to guess root\'s addresses when its env file names no PUBLIC_URL', () => {
    const repo = scratch();
    const file = join(repo, 'backend.env');
    writeFileSync(file, 'ROLE=root\n');
    const ran = ensure(repo, file, repo, join(repo, 'none.env'));
    expect(ran.status).not.toBe(0);
    expect(ran.stderr).toContain('PUBLIC_URL is not set');
    expect(readFileSync(file, 'utf8')).toBe('ROLE=root\n');
  });
});

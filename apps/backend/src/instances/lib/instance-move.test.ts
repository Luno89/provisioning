import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { generateIdentityKey, identityKeysFrom, issueMoveToken, checkMoveToken, trustedKeys, publicKeyPem } from './identity-token.js';
import { answersWhileMoving, keysEnv, keysFromEnv, moveProblem, movedRecord, movedStateSecrets, MOVE_PARTS, MOVE_STEP_WORDS, PG_DUMP, PG_RESTORE } from './instance-move.js';
import { kubeAccessFrom, serviceProxyPath } from './kubeconfig-access.js';

const KEYS = { SESSION_KEY: 'a'.repeat(64), DATA_KEY: 'b'.repeat(64), PAYLOAD_KEY: 'c'.repeat(64), EGRESS_KEY: 'd'.repeat(64) };

describe('what a move carries', () => {
  it('carries the Secrets Terraform keeps each stack\'s state in, as Secrets of no cluster in particular, and nothing else', () => {
    expect(MOVE_PARTS).toContain('terraform-state');
    expect(MOVE_STEP_WORDS['terraform-state']).toBe('Copying what Terraform knows of its apps');
    expect(movedStateSecrets({ items: [
      { kind: 'Secret', metadata: { name: 'tfstate-default-b-state', namespace: 'pool', uid: 'u', resourceVersion: '3', ownerReferences: [], labels: { tfstate: 'true', tfstateWorkspace: 'default' }, annotations: { a: 'b' } }, type: 'Opaque', data: { tfstate: 'eA==' } },
      { kind: 'Secret', metadata: { name: 'tfstate-default-a-state', labels: { tfstate: 'true' } } },
      { kind: 'Secret', metadata: { name: 'someone-elses', labels: { tfstate: 'false' } }, data: { x: 'eQ==' } },
      { kind: 'ConfigMap', metadata: { name: 'tfstate-lookalike', labels: { tfstate: 'true' } } },
      { kind: 'Secret', metadata: { labels: { tfstate: 'true' } } },
    ] })).toEqual([
      { apiVersion: 'v1', kind: 'Secret', metadata: { name: 'tfstate-default-a-state', labels: { tfstate: 'true' } }, data: {} },
      { apiVersion: 'v1', kind: 'Secret', metadata: { name: 'tfstate-default-b-state', labels: { tfstate: 'true', tfstateWorkspace: 'default' } }, type: 'Opaque', data: { tfstate: 'eA==' } },
    ]);
    expect(movedStateSecrets({})).toEqual([]);
  });

  it('carries exactly the instance\'s four keys, and takes back only those', () => {
    const text = keysEnv({ ...KEYS, MONGO_ROOT_PASSWORD: 'x'.repeat(40) });
    expect(text).toBe(`SESSION_KEY=${KEYS.SESSION_KEY}\nDATA_KEY=${KEYS.DATA_KEY}\nPAYLOAD_KEY=${KEYS.PAYLOAD_KEY}\nEGRESS_KEY=${KEYS.EGRESS_KEY}\n`);
    expect(keysFromEnv(text as string)).toEqual(KEYS);
    expect(keysEnv({ ...KEYS, DATA_KEY: '' })).toEqual({ error: 'this instance has no DATA_KEY' });
    expect(keysEnv({ ...KEYS, DATA_KEY: 'has spaces and $(rm -rf /) in it' })).toEqual({ error: 'DATA_KEY is not a key this move can carry' });
    expect(keysFromEnv('SESSION_KEY=aaaaaaaaaaaaaaaa\nPATH=/bin')).toEqual({ error: 'the keys that came over are not the keys a move carries' });
  });

  it('moves only a running or stopped instance on Koala\'s servers, and not twice at once', () => {
    const pool = { ports: { backend: 1, edge: 2, registry: 3 }, startedAt: 'then', trialEndsAt: 'later' };
    expect(moveProblem({ name: 'bo', status: 'ready', pool })).toBeUndefined();
    expect(moveProblem({ name: 'bo', status: 'paused', pool })).toBeUndefined();
    expect(moveProblem({ name: 'bo', status: 'ready' })).toContain('only an instance on Koala\'s servers');
    expect(moveProblem({ name: 'bo', status: 'installing', pool })).toContain('still being set up');
    expect(moveProblem({ name: 'bo', status: 'ready', pool, move: { state: 'switching', startedAt: 'now' } })).toContain('switching');
  });

  it('dumps each Postgres as its superuser where there is one, and restores as the superuser into a fresh database owned by the app\'s user, stopping at the first error and reading its input to the end', () => {
    expect(PG_DUMP).toContain('PGUSER=postgres');
    expect(PG_DUMP).toContain('exec pg_dump -d "$POSTGRES_DATABASE" -Fc');
    expect(PG_RESTORE).toContain('DROP DATABASE IF EXISTS \\"$POSTGRES_DATABASE\\" WITH (FORCE);');
    expect(PG_RESTORE).toContain('CREATE DATABASE \\"$POSTGRES_DATABASE\\" OWNER \\"$POSTGRES_USER\\";');
    expect(PG_RESTORE).toContain('$(cat "$POSTGRES_POSTGRES_PASSWORD_FILE")');
    expect(PG_RESTORE).toMatch(/; s=\$\?; cat > \/dev\/null; exit \$s$/);
    expect(PG_RESTORE).toContain('pg_restore --no-owner --no-acl --exit-on-error --role="$POSTGRES_USER"');
  });
});

describe('root asking a pool instance for a part of itself', () => {
  const keys = identityKeysFrom(generateIdentityKey());
  const trusted = trustedKeys([publicKeyPem(keys.publicKey)]);
  const now = 1_800_000_000;

  it('is believed for that instance and that part only, for a minute', () => {
    const token = issueMoveToken(keys, 'inst-1', 'mongo', now);
    expect(checkMoveToken(token, trusted, 'inst-1', 'mongo', now)).toMatchObject({ ok: true });
    expect(checkMoveToken(token, trusted, 'inst-2', 'mongo', now)).toEqual({ ok: false, reason: 'wrong-audience' });
    expect(checkMoveToken(token, trusted, 'inst-1', 'keys', now)).toEqual({ ok: false, reason: 'wrong-audience' });
    expect(checkMoveToken(token, trusted, 'inst-1', 'mongo', now + 61)).toEqual({ ok: false, reason: 'expired' });
    const other = identityKeysFrom(generateIdentityKey());
    expect(checkMoveToken(issueMoveToken(other, 'inst-1', 'mongo', now), trusted, 'inst-1', 'mongo', now)).toEqual({ ok: false, reason: 'unknown-key' });
    const [, body] = issueMoveToken(keys, 'inst-1', 'mongo', now).split('.') as [string, string];
    const otherKind = `${Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'nowrinkles-handoff', kid: keys.kid })).toString('base64url')}.${body}`;
    expect(checkMoveToken(`${otherKind}.${crypto.sign(null, Buffer.from(otherKind), keys.privateKey).toString('base64url')}`, trusted, 'inst-1', 'mongo', now)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('calls a token whose header or claims are not an object malformed rather than failing on it', () => {
    const [, body, signature] = issueMoveToken(keys, 'inst-1', 'mongo', now).split('.') as [string, string, string];
    const nothing = Buffer.from('null').toString('base64url');
    expect(checkMoveToken(`${nothing}.${body}.${signature}`, trusted, 'inst-1', 'mongo', now)).toEqual({ ok: false, reason: 'malformed' });
    expect(checkMoveToken(`${body}.${nothing}.${signature}`, trusted, 'inst-1', 'mongo', now)).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('reaching a pool instance through the pool node\'s API server', () => {
  it('reads the server and client certificate from the kubeconfig and proxies to the synced service', () => {
    const access = kubeAccessFrom([
      'apiVersion: v1', 'kind: Config', 'current-context: default',
      'clusters:', '- name: default', '  cluster:', '    server: https://127.0.0.1:6443/', `    certificate-authority-data: ${Buffer.from('ca').toString('base64')}`,
      'users:', '- name: default', '  user:', `    client-certificate-data: ${Buffer.from('cert').toString('base64')}`, `    client-key-data: ${Buffer.from('key').toString('base64')}`,
      'contexts:', '- name: default', '  context:', '    cluster: default', '    user: default',
    ].join('\n'));
    expect(access.server).toBe('https://127.0.0.1:6443');
    expect(access.ca?.toString()).toBe('ca');
    expect(access.cert?.toString()).toBe('cert');
    expect(access.key?.toString()).toBe('key');
    expect(serviceProxyPath('pool-bo', 'instance-x-nowrinkles-x-bo', 80, '/api/move/parts/keys?token=t'))
      .toBe('/api/v1/namespaces/pool-bo/services/http:instance-x-nowrinkles-x-bo:80/proxy/api/move/parts/keys?token=t');
  });
});

describe('a pool instance while it moves', () => {
  it('still answers the move, its own status and the check that keeps it in service, and nothing else', () => {
    expect(['/move/parts/keys', '/instance-trial/move', '/auth/me', '/auth/sign-in'].every(answersWhileMoving)).toBe(true);
    expect(['/engine/runs', '/projects', '/auth/handoff', '/conversations/x/messages'].some(answersWhileMoving)).toBe(false);
  });
});

describe('the record a move switches to', () => {
  const pool = { ports: { backend: 35000, edge: 35001, registry: 35002 }, startedAt: 't', trialEndsAt: 't' };
  const moving = {
    id: 'inst-bo', ownerId: 'bo', name: 'bo', url: 'https://bo.koala.dev', status: 'ready' as const, createdAt: 't', updatedAt: 't', credentialHash: 'pool', meshIp: '100.64.0.1', pool,
    setup: { revision: 4, state: 'up' as const, stage: 'set-up', title: 'Koala is set up', at: 't' },
    install: { id: 'install-1', machineId: 'desk', state: 'ready' as const, at: 't', imageTag: 'v7', move: true as const },
    move: { state: 'switching' as const, startedAt: 't', credentialHash: 'moved', target: { machine: 'bo-desktop', meshIp: '100.64.0.20', url: 'http://100.64.0.20:30320' }, setup: { revision: 1, state: 'up' as const, stage: 'set-up', title: 'Koala is set up', at: 't' } },
  };

  it('names the machine it moved to, with the move\'s credential, address, setup and release, and nothing of the pool', () => {
    const moved = movedRecord(moving);
    expect(moved).toMatchObject({
      machineId: 'desk', machine: 'bo-desktop', meshIp: '100.64.0.20', url: 'http://100.64.0.20:30320', credentialHash: 'moved', running: 'v7',
      status: 'ready', detail: 'Moved to bo-desktop', setup: { revision: 1 }, install: { id: 'install-1', state: 'ready' },
    });
    expect(moved).not.toHaveProperty('pool');
    expect(moved).not.toHaveProperty('move');
  });

  it('refuses a move that never said where it answers, or never had a machine', () => {
    expect(movedRecord({ ...moving, move: { ...moving.move, target: { machine: 'bo-desktop', meshIp: '100.64.0.20' } } })).toEqual({ error: 'the new machine never said where it answers' });
    const { install: _install, ...noInstall } = moving;
    expect(movedRecord(noInstall)).toEqual({ error: 'the move has no machine it was put on' });
  });
});

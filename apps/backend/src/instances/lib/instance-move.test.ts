import { describe, expect, it } from 'vitest';
import { generateIdentityKey, identityKeysFrom, issueMoveToken, checkMoveToken, trustedKeys, publicKeyPem, issueHandoff } from './identity-token.js';
import { answersWhileMoving, keysEnv, keysFromEnv, moveProblem, PG_DUMP, PG_RESTORE } from './instance-move.js';
import { kubeAccessFrom, serviceProxyPath } from './kubeconfig-access.js';

const KEYS = { SESSION_KEY: 'a'.repeat(64), DATA_KEY: 'b'.repeat(64), PAYLOAD_KEY: 'c'.repeat(64), EGRESS_KEY: 'd'.repeat(64) };

describe('what a move carries', () => {
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
    expect(checkMoveToken(issueHandoff(keys, { userId: 'u', email: 'e' }, 'inst-1', now), trusted, 'inst-1', 'mongo', now)).toEqual({ ok: false, reason: 'malformed' });
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

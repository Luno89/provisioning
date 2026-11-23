import { describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { JOIN_PROGRESS_PATH } from '@koala/engine-core/machine-join';
import { KOALA_INSTALL_FOLLOW_PATH, koalaInstallProgressPath } from '@koala/engine-core/koala-install';
import { createAuth } from './platform/middleware/auth.js';
import { BrowserSessions } from './platform/services/BrowserSessions.js';
import { AccessRevocations } from './platform/services/AccessRevocations.js';
import { memoryDatabase } from './platform/testing/memory-database.js';
import { openRoutesOf } from './open-routes.js';
import { guardedBy } from './platform/testing/guarded.js';

const underApi = (path: string): string => {
  if (!path.startsWith('/api/')) throw new Error(`${path} is not under /api, where root's guard stands`);
  return path.slice('/api'.length);
};

async function guarded(role: 'root' | 'instance', method: string, path: string) {
  const req = { method, url: underApi(path), path: underApi(path), originalUrl: path, baseUrl: '/api', headers: { authorization: 'Bearer from-the-machine' } } as unknown as Request;
  const db = memoryDatabase();
  const sessions = new BrowserSessions({ store: db.platform, secret: 'k', securedFor: () => false });
  const auth = createAuth({
    db, publicUrl: 'http://localhost:3001', role, open: openRoutesOf(role),
    throughRoot: { sessions, signIn: { fresh: () => { throw new Error('no one is signed in here'); }, end: () => { throw new Error('no one is signed in here'); } } },
    ...(role === 'root' ? { revocations: new AccessRevocations() } : {}),
  });
  return guardedBy(auth.requireAuth, req);
}

describe('a person\'s removal on root, once they are signed out everywhere', () => {
  it('shows its progress past root\'s session guard, and keeps what it would take behind it', async () => {
    expect(await guarded('root', 'GET', '/api/account/removal/progress')).toEqual({ statusCode: 0, body: undefined, nexted: true });
    expect((await guarded('root', 'GET', '/api/account/removal')).statusCode).toBe(401);
    expect((await guarded('instance', 'GET', '/api/account/removal/progress')).statusCode).toBe(401);
  });
});

describe('the routes a machine calls on root with its own credential', () => {
  it('reach their route past root\'s session guard, which a machine has no cookie for', async () => {
    for (const [method, path] of [
      ['POST', JOIN_PROGRESS_PATH],
      ['POST', koalaInstallProgressPath('install-1')],
      ['GET', KOALA_INSTALL_FOLLOW_PATH],
    ] as const) {
      expect(await guarded('root', method, path), `${method} ${path}`).toEqual({ statusCode: 0, body: undefined, nexted: true });
    }
  });
});

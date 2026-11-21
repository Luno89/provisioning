import { describe, expect, it } from 'vitest';
import type { Request, Response } from 'express';
import { JOIN_PROGRESS_PATH } from '@koala/engine-core/machine-join';
import { KOALA_INSTALL_FOLLOW_PATH, koalaInstallProgressPath } from '@koala/engine-core/koala-install';
import { createAuth } from './platform/middleware/auth.js';
import { openRoutesOf } from './open-routes.js';

const noEnds = { ended: () => false, end: async () => undefined };

const underApi = (path: string): string => {
  if (!path.startsWith('/api/')) throw new Error(`${path} is not under /api, where root's guard stands`);
  return path.slice('/api'.length);
};

async function guarded(role: 'root' | 'instance', method: string, path: string) {
  let statusCode = 0;
  let body: unknown;
  let nexted = false;
  const req = { method, url: underApi(path), path: underApi(path), originalUrl: path, baseUrl: '/api', headers: { authorization: 'Bearer from-the-machine' } } as unknown as Request;
  const res = {
    status(code: number) { statusCode = code; return this; },
    json(payload: unknown) { body = payload; return this; },
  } as unknown as Response;
  const auth = createAuth({ db: null as never, sessionKey: 'k', publicUrl: 'http://localhost:3001', role, open: openRoutesOf(role), sessionEnds: noEnds });
  await auth.requireAuth(req, res, () => { nexted = true; });
  return { statusCode, body, nexted };
}

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

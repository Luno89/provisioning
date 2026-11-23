import { describe, expect, it } from 'vitest';
import type { Request, Response } from 'express';
import { createAuth } from './auth.js';
import { BrowserSessions } from '../services/BrowserSessions.js';
import { memoryDatabase } from '../testing/memory-database.js';

describe('the session guard, when what it asks fails', () => {
  it('hands the failure on to the error responder rather than leaving the request unanswered', async () => {
    const failure = new Error('root could not be reached to check the token');
    const db = memoryDatabase();
    const sessions = new BrowserSessions({ store: db.platform, secret: 'k', securedFor: () => false });
    const auth = createAuth({
      db, publicUrl: 'http://localhost:3001', role: 'instance', open: [],
      throughRoot: { sessions, signIn: { fresh: () => { throw new Error('no one is signed in here'); }, end: () => { throw new Error('no one is signed in here'); } } },
      bearer: () => Promise.reject(failure),
    });
    const req = { method: 'GET', url: '/anything', path: '/anything', originalUrl: '/api/anything', baseUrl: '/api', headers: { authorization: 'Bearer from-a-machine' } } as unknown as Request;
    const res = {} as Response;
    const handed = new Promise<unknown>((resolve, reject) => {
      Promise.resolve(auth.requireAuth(req, res, resolve)).catch(reject);
    });
    await expect(handed).resolves.toBe(failure);
  });
});

import { join } from 'node:path';
import express from 'express';
import { describe, expect, it } from 'vitest';
import { clientCallsIn, routesOf } from './http-edges.js';

const CLIENT = join(import.meta.dirname, 'fixture-http', 'src', 'client');

describe('the routes Express mounts and the calls the browser makes', () => {
  it('names a parameter in the path a router is mounted at, as the route that runs under it is written', () => {
    const steps = express.Router({ mergeParams: true });
    steps.post('/login', (_req, res) => { res.json({}); });
    const sessions = express.Router();
    sessions.use('/:sid', steps);
    const app = express();
    app.use('/sessions', sessions);
    expect(routesOf(app as unknown as Parameters<typeof routesOf>[0])).toEqual([{ method: 'POST', path: '/sessions/:sid/login' }]);
  });

  it('reads a call through the second client at its own base, with a path a parameter\'s type names', () => {
    const { calls, unread } = clientCallsIn(CLIENT, CLIENT, [{ name: 'site', base: '' }]);
    expect(calls.map((call) => `${call.method} ${call.path} ${call.file}`)).toEqual(['POST /sessions/:*/login sessions.ts']);
    expect(unread).toEqual([]);
  });
});

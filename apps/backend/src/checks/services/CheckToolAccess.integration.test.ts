import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { level2Options } from '../testing/level2-options.js';
import axios from 'axios';
import { mountRouter, type Harness } from '../../platform/routes/test-harness.js';
import type { Scenario } from '../../eval/level2/scenario.js';
import { evalsLevel2Router } from '../routes/evals-level2.js';
import { bearerApi, httpCheckAccess } from './CheckToolAccess.js';
import express from 'express';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Level2Service } from './Level2Service.js';

const SCENARIO: Scenario = {
  id: 'tidy-saves', name: 'Tidy saves', describe: 'It writes what it was given.', agent: 'agent-builder',
  procedure: { id: 'tool-rounds' }, input: { message: 'save it' }, expect: { outcome: 'ok' },
};

const BO = { ownerId: 'bo', grantId: 'grant-1' };

let harness: Harness;
let started: string[];

beforeAll(async () => {
  started = [];
  harness = await mountRouter({
    prefix: '/api/evals/level2',
    router: (db) => evalsLevel2Router({
      level2: new Level2Service(level2Options(db, { start: async (workflowId) => { started.push(workflowId); }, cancel: async () => false, outcome: () => new Promise(() => undefined) }, [])),
    }),
  });
});

afterAll(async () => { await harness.close(); });

const access = () => httpCheckAccess(async () => axios.create({ baseURL: harness.url('/api') }));

describe('the check tools acting as the person through the API', () => {
  it('saves a check, lists it, starts a run of it and reads the run, through the routes the Checks page uses', async () => {
    const checks = access();
    expect(await checks.save(BO, SCENARIO)).toEqual({ saved: 'tidy-saves' });
    expect((await checks.scenarios(BO)).map((scenario) => scenario.id)).toContain('tidy-saves');

    const result = await checks.start(BO, { only: ['tidy-saves'] });
    expect(result).toEqual({ runId: expect.any(String) as unknown });
    const runId = (result as { runId: string }).runId;
    expect(started).toEqual([`check-run-${runId}`]);
    expect((await checks.runs(BO)).map((run) => run.id)).toEqual([runId]);
    expect(await checks.run(BO, runId)).toMatchObject({ id: runId, state: 'running' });
  });

  it('hands back every problem a check was refused for, and why a run did not start', async () => {
    const checks = access();
    expect(await checks.save(BO, { ...SCENARIO, id: 'nobody-home', agent: 'nobody' })).toEqual({ problems: expect.arrayContaining(['there is no agent called "nobody"']) as unknown });
    expect(await checks.save(BO, {})).toEqual({ problems: ['a check needs an id: lower-case words joined by dashes'] });
    expect(await checks.start(BO, { only: ['ghost'] })).toEqual({ problem: 'there is no scenario called "ghost"' });
  });

  it('says a run or check is not there rather than failing', async () => {
    const checks = access();
    expect(await checks.run(BO, 'nope')).toBeUndefined();
    expect(await checks.remove(BO, 'nope')).toBe(false);
    await checks.save(BO, { ...SCENARIO, id: 'short-lived' });
    expect(await checks.remove(BO, 'short-lived')).toBe(true);
    expect(await checks.remove(BO, 'short-lived')).toBe(false);
  });

  it('lets a server fault through, rather than passing it off as a refusal', async () => {
    const down = httpCheckAccess(async () => axios.create({ baseURL: 'http://127.0.0.1:1/api' }));
    await expect(down.start(BO, { only: ['a'] })).rejects.toThrow();
  });
});

describe('the API as a run, with its token', () => {
  it('sends each request with the run\'s token as it is at that moment', async () => {
    const app = express();
    app.get('/api/who', (req, res) => { res.json({ said: req.headers.authorization }); });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const tokens = ['first', 'renewed'];
    const api = bearerApi(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api`, async () => tokens.shift()!);
    expect((await api.get('/who')).data).toEqual({ said: 'Bearer first' });
    expect((await api.get('/who')).data).toEqual({ said: 'Bearer renewed' });
    server.close();
  });
});

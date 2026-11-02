import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import axios from 'axios';
import { BUILDER_TOOLS } from '@koala/agent-engine';
import { mountRouter, type Harness } from '../../platform/routes/test-harness.js';
import { ENGINE_TOOL_SEEDS } from '../../engine-host/tools/engine-tool-seeds.js';
import { seededPersonas } from '../../extensions/seeds.js';
import type { Scenario } from '../../eval/level2/scenario.js';
import { evalsLevel2Router } from '../routes/evals-level2.js';
import { httpCheckAccess } from './CheckToolAccess.js';
import { Level2Service } from './Level2Service.js';

const SCENARIO: Scenario = {
  id: 'tidy-saves', name: 'Tidy saves', describe: 'It writes what it was given.', agent: 'agent-builder',
  procedure: { id: 'tool-rounds' }, input: { message: 'save it' }, expect: { outcome: 'ok' },
};

let harness: Harness;
let started: string[];

beforeAll(async () => {
  started = [];
  harness = await mountRouter({
    prefix: '/api/evals/level2',
    router: (db) => evalsLevel2Router({
      level2: new Level2Service({
        checks: { start: async (workflowId) => { started.push(workflowId); }, cancel: async () => false, outcome: () => new Promise(() => undefined) },
        tools: async () => [...BUILDER_TOOLS, ...ENGINE_TOOL_SEEDS],
        agents: async () => seededPersonas().map((agent) => agent.slug),
        procedures: async () => ['tool-rounds'],
        store: db.checks,
        builtIn: [],
      }),
    }),
  });
});

afterAll(async () => { await harness.close(); });

const access = () => httpCheckAccess(async () => axios.create({ baseURL: harness.url('/api') }));

describe('the check tools acting as the person through the API', () => {
  it('saves a check, lists it, starts a run of it and reads the run, through the routes the Checks page uses', async () => {
    const checks = access();
    expect(await checks.save('bo', SCENARIO)).toEqual({ saved: 'tidy-saves' });
    expect((await checks.scenarios('bo')).map((scenario) => scenario.id)).toContain('tidy-saves');

    const result = await checks.start('bo', { only: ['tidy-saves'] });
    expect(result).toEqual({ runId: expect.any(String) as unknown });
    const runId = (result as { runId: string }).runId;
    expect(started).toEqual([`check-run-${runId}`]);
    expect((await checks.runs('bo')).map((run) => run.id)).toEqual([runId]);
    expect(await checks.run('bo', runId)).toMatchObject({ id: runId, state: 'running' });
  });

  it('hands back every problem a check was refused for, and why a run did not start', async () => {
    const checks = access();
    expect(await checks.save('bo', { ...SCENARIO, id: 'nobody-home', agent: 'nobody' })).toEqual({ problems: expect.arrayContaining(['there is no agent called "nobody"']) as unknown });
    expect(await checks.save('bo', {})).toEqual({ problems: ['a check needs an id: lower-case words joined by dashes'] });
    expect(await checks.start('bo', { only: ['ghost'] })).toEqual({ problem: 'there is no scenario called "ghost"' });
  });

  it('says a run or check is not there rather than failing', async () => {
    const checks = access();
    expect(await checks.run('bo', 'nope')).toBeUndefined();
    expect(await checks.remove('bo', 'nope')).toBe(false);
    await checks.save('bo', { ...SCENARIO, id: 'short-lived' });
    expect(await checks.remove('bo', 'short-lived')).toBe(true);
    expect(await checks.remove('bo', 'short-lived')).toBe(false);
  });

  it('lets a server fault through, rather than passing it off as a refusal', async () => {
    const down = httpCheckAccess(async () => axios.create({ baseURL: 'http://127.0.0.1:1/api' }));
    await expect(down.start('bo', { only: ['a'] })).rejects.toThrow();
  });
});

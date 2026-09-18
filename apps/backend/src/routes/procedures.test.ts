import { describe, it, expect } from 'vitest';
import axios from 'axios';
import { BUILT_IN_GROUPS, EXAMPLE_PROCEDURE, RESEARCH_V2, builtInCatalogue } from '@koala/agent-engine/procedure';
import { procedureToBuilderCode } from '@koala/agent-engine/procedure-builder';
import { mountRouter, TEST_USER, type Harness } from './test-harness.js';
import { proceduresRouter } from './procedures.js';
import { ProcedureService } from '../services/ProcedureService.js';
import { createProcedureStore } from '../engine-host/registries/procedure-store.js';

const harness = (): Promise<Harness> => mountRouter({
  prefix: '/api/procedures',
  router: (db) => proceduresRouter({
    procedures: new ProcedureService({
      procedures: createProcedureStore({ sources: { list: (ownerId) => db.getProcedures(ownerId) } }),
      sources: {
        get: (ownerId, id) => db.getProcedure(ownerId, id),
        save: (source) => db.saveProcedure(source),
        delete: (ownerId, id) => db.deleteProcedure(ownerId, id),
      },
      known: async () => ({ tools: new Set(['list_tasks']), agents: new Set(['research']) }),
      effort: { list: (ownerId, procedureId) => db.getRunEffort(ownerId, procedureId) },
      now: () => '2026-09-16T00:00:00.000Z',
    }),
  }),
});

const quiet = { validateStatus: () => true };

describe('procedures routes', () => {
  it('lists the built-ins, marked as not yours', async () => {
    const h = await harness();
    const res = await axios.get(h.url('/api/procedures'));

    expect(res.data.procedures.map((p: { id: string }) => p.id)).toEqual(expect.arrayContaining(['research', 'tool-rounds', 'delivery']));
    expect(res.data.procedures.find((p: { id: string }) => p.id === 'research')).toMatchObject({ mine: false, version: '2' });
    expect(res.data.unreadable).toEqual([]);

    await h.close();
  });

  it('reads one procedure in full, and says when there is none', async () => {
    const h = await harness();

    expect((await axios.get(h.url('/api/procedures/research'))).data).toEqual({ procedure: RESEARCH_V2, mine: false });
    expect((await axios.get(h.url('/api/procedures/ghost'), quiet)).status).toBe(404);

    await h.close();
  });

  it('checks a procedure without saving it, naming each problem\'s node', async () => {
    const h = await harness();
    const res = await axios.post(h.url('/api/procedures/check'), { ...EXAMPLE_PROCEDURE, flow: [] });

    expect(res.status).toBe(200);
    expect(res.data.problems).toContainEqual(expect.objectContaining({ node: 'turn', exit: 'toolCalls' }));
    expect((await axios.get(h.url('/api/procedures'))).data.procedures.some((p: { id: string }) => p.id === 'quick-answer')).toBe(false);

    await h.close();
  });

  it('saves your own copy, bumping the version each save, and only you see it', async () => {
    const h = await harness();

    const first = await axios.put(h.url('/api/procedures/quick-answer'), EXAMPLE_PROCEDURE);
    const second = await axios.put(h.url('/api/procedures/quick-answer'), EXAMPLE_PROCEDURE);
    expect(first.data.procedure.version).toBe('1');
    expect(second.data.procedure.version).toBe('2');
    expect((await axios.get(h.url('/api/procedures/quick-answer'))).data).toMatchObject({ mine: true, procedure: { version: '2' } });

    h.setUser({ ...TEST_USER, id: 'someone-else' });
    expect((await axios.get(h.url('/api/procedures/quick-answer'), quiet)).status).toBe(404);

    await h.close();
  });

  it('shadows a built-in with your copy, and deleting the copy brings the built-in back', async () => {
    const h = await harness();

    await axios.put(h.url('/api/procedures/research'), { ...RESEARCH_V2, budget: { maxRounds: 9 } });
    expect((await axios.get(h.url('/api/procedures/research'))).data).toMatchObject({ mine: true, procedure: { budget: { maxRounds: 9 } } });

    expect((await axios.delete(h.url('/api/procedures/research'))).status).toBe(200);
    expect((await axios.get(h.url('/api/procedures/research'))).data).toEqual({ procedure: RESEARCH_V2, mine: false });
    expect((await axios.delete(h.url('/api/procedures/research'), quiet)).status).toBe(404);

    await h.close();
  });

  it('refuses to save what does not check clean, what is not this format, or under another id', async () => {
    const h = await harness();

    const broken = await axios.put(h.url('/api/procedures/quick-answer'), { ...EXAMPLE_PROCEDURE, flow: [] }, quiet);
    const old = await axios.put(h.url('/api/procedures/old'), { id: 'old', initialStep: 'x', nodes: [] }, quiet);
    const renamed = await axios.put(h.url('/api/procedures/other'), EXAMPLE_PROCEDURE, quiet);

    expect(broken.status).toBe(400);
    expect(old.data.problems[0].message).toMatch(/needs "schema": 2/);
    expect(renamed.data.problems[0].message).toBe('this procedure is "quick-answer", not "other"');
    expect((await axios.get(h.url('/api/procedures'))).data.procedures.some((p: { mine: boolean }) => p.mine)).toBe(false);

    await h.close();
  });

  it('saves a procedure written as builder code, placing nodes the code did not position, and says where code is wrong', async () => {
    const h = await harness();
    const code = procedureToBuilderCode({ ...RESEARCH_V2, id: 'from-code', name: 'From code' }, { catalogue: builtInCatalogue(), groups: BUILT_IN_GROUPS })
      .replace(/\n  p\.layout\(\{[\s\S]*?\n  \}\)\n/, '\n');

    const saved = await axios.put(h.url('/api/procedures/from-code/builder'), { code }, quiet);
    const broken = await axios.put(h.url('/api/procedures/from-code/builder'), { code: code.replace("turn.on('answered', answered)", "turn.on('answerd', answered)") }, quiet);
    const escaping = await axios.put(h.url('/api/procedures/from-code/builder'), { code: code.replace('(p) => {', '(p) => {\n  process.exit(1)') }, quiet);

    expect(saved.status).toBe(200);
    expect(saved.data.procedure).toMatchObject({ id: 'from-code', name: 'From code', version: '1', start: 'provision' });
    expect(saved.data.procedure.nodes.map((node: { id: string }) => node.id)).toEqual(RESEARCH_V2.nodes.map((node) => node.id));
    expect(broken.status).toBe(400);
    expect(broken.data.problems[0].message).toMatch(/^line \d+, column \d+: Model Turn "turn" has no exit called "answerd"/);
    expect(escaping.status).toBe(400);
    expect(escaping.data.problems[0].message).toContain('"process" is not declared');
    await h.close();
  });

  it("reports each model's track record on a procedure, and only the caller's own runs", async () => {
    let db: Parameters<Parameters<typeof mountRouter>[0]['router']>[0] | undefined;
    const h = await mountRouter({
      prefix: '/api/procedures',
      router: (database) => {
        db = database;
        return proceduresRouter({
          procedures: new ProcedureService({
            procedures: createProcedureStore({ sources: { list: (ownerId) => database.getProcedures(ownerId) } }),
            sources: { get: async () => undefined, save: async () => undefined, delete: async () => undefined },
            known: async () => ({ tools: new Set(), agents: new Set() }),
            effort: { list: (ownerId, procedureId) => database.getRunEffort(ownerId, procedureId) },
          }),
        });
      },
    });
    const effort = (runId: string, ownerId: string, rounds: number) => db!.saveRunEffort({
      runId, ownerId, agentSlug: 'research', procedureId: 'research', procedureVersion: '2', modelKey: 'tabby', modelLabel: 'Tabby',
      outcome: 'ok', rounds, toolCalls: 2, totalTokens: 900, childRuns: 0, longestReply: 0, cappedAt: 0, steps: 12, wallClockMs: 30_000, ask: 'q', limits: {},
      finishedAt: `2026-09-17T00:00:0${runId.slice(-1)}.000Z`,
    });
    for (const [index, rounds] of [3, 4, 4, 5, 6].entries()) await effort(`run-${index}`, TEST_USER.id, rounds);
    await effort('run-9', 'someone-else', 90);

    const res = await axios.get(h.url('/api/procedures/research/track-record'));

    expect(res.status).toBe(200);
    expect(res.data.records).toEqual([expect.objectContaining({
      modelKey: 'tabby', runs: 5, successes: 5, typical: expect.objectContaining({ rounds: 6 }), limits: expect.objectContaining({ maxRounds: 9 }),
    })]);
    await h.close();
  });
});

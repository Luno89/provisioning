import { describe, it, expect } from 'vitest';
import { BUILT_IN_GROUPS, EXAMPLE_PROCEDURE, PROCEDURE_SCHEMA, RESEARCH_V2, builtInCatalogue, defineGroup } from '@koala/agent-engine/procedure';
import { procedureToBuilderCode } from '@koala/agent-engine/procedure-builder';
import { anyOf, arrayWith, objectWith } from '../../platform/lib/test-matchers.js';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import type { Database } from '../../platform/lib/db-interface.js';
import { INSTALLED_EXTENSIONS, platformCatalogue, platformGroups } from '../../extensions/installed.js';
import { createProcedureStore } from '../../engine-host/registries/procedure-store.js';
import { ExtensionService } from './ExtensionService.js';
import { ProcedureService, type ProcedureServiceOptions } from './ProcedureService.js';

const OWNER = 'u1';

const serviceOn = (db: Database, over: Partial<ProcedureServiceOptions> = {}): ProcedureService => new ProcedureService({
  procedures: createProcedureStore({ sources: { list: (ownerId) => db.engine.getProcedures(ownerId) } }),
  sources: {
    get: (ownerId, id) => db.engine.getProcedure(ownerId, id),
    save: (source) => db.engine.saveProcedure(source),
    delete: (ownerId, id) => db.engine.deleteProcedure(ownerId, id),
  },
  known: async () => ({ tools: new Set(['list_tasks']), agents: new Set(['research']) }),
  effort: { list: (ownerId, procedureId) => db.engine.getRunEffort(ownerId, procedureId) },
  now: () => '2026-09-16T00:00:00.000Z',
  ...over,
});

describe('a person\'s procedures', () => {
  it('lists the built-ins, marked as not theirs, with what each needs to be granted', async () => {
    const listed = await serviceOn(memoryDatabase()).list(OWNER);
    expect(listed.procedures.map((p) => p.id)).toEqual(arrayWith(['research', 'tool-rounds', 'delivery']));
    expect(listed.procedures.find((p) => p.id === 'research')).toMatchObject({ mine: false, ofBuiltIn: true, version: '4', requires: anyOf(Array) });
    expect(listed.unreadable).toEqual([]);
  });

  it('lists them by name', async () => {
    const names = (await serviceOn(memoryDatabase()).list(OWNER)).procedures.map((p) => p.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it('reads one in full, and says when there is none', async () => {
    const service = serviceOn(memoryDatabase());
    expect(await service.get(OWNER, 'research')).toEqual({ procedure: RESEARCH_V2, mine: false });
    expect(await service.get(OWNER, 'ghost')).toBeUndefined();
  });

  it('checks a procedure without saving it, naming each problem\'s node', async () => {
    const db = memoryDatabase();
    const service = serviceOn(db);
    expect(await service.check(OWNER, { ...EXAMPLE_PROCEDURE, flow: [] })).toContainEqual(objectWith({ node: 'turn', exit: 'toolCalls' }));
    expect((await service.list(OWNER)).procedures.some((p) => p.id === 'quick-answer')).toBe(false);
  });

  it('says what is wrong with something that is not a procedure', async () => {
    const problems = await serviceOn(memoryDatabase()).check(OWNER, { id: 'old', initialStep: 'x', nodes: [] });
    expect(problems[0]?.message).toMatch(/needs "schema": 2/);
  });

  it('saves their own copy, bumping the version each save, and only they see it', async () => {
    const db = memoryDatabase();
    const service = serviceOn(db);
    const first = await service.save(OWNER, 'quick-answer', EXAMPLE_PROCEDURE);
    const second = await service.save(OWNER, 'quick-answer', EXAMPLE_PROCEDURE);
    expect(first).toMatchObject({ saved: true, procedure: { version: '1' } });
    expect(second).toMatchObject({ saved: true, procedure: { version: '2' } });
    expect(await service.get(OWNER, 'quick-answer')).toMatchObject({ mine: true, procedure: { version: '2' } });
    expect((await db.engine.getProcedure(OWNER, 'quick-answer'))?.updatedAt).toBe('2026-09-16T00:00:00.000Z');
    expect(await service.get('someone-else', 'quick-answer')).toBeUndefined();
  });

  it('shadows a built-in with their copy, and removing the copy brings the built-in back', async () => {
    const service = serviceOn(memoryDatabase());
    await service.save(OWNER, 'research', { ...RESEARCH_V2, budget: { maxRounds: 9 } });
    expect(await service.get(OWNER, 'research')).toMatchObject({ mine: true, procedure: { budget: { maxRounds: 9 } } });

    expect(await service.remove(OWNER, 'research')).toBe(true);
    expect(await service.get(OWNER, 'research')).toEqual({ procedure: RESEARCH_V2, mine: false });
    expect(await service.remove(OWNER, 'research')).toBe(false);
  });

  it('refuses to save what does not check clean, what is not this format, or under another id', async () => {
    const service = serviceOn(memoryDatabase());
    const broken = await service.save(OWNER, 'quick-answer', { ...EXAMPLE_PROCEDURE, flow: [] });
    const old = await service.save(OWNER, 'old', { id: 'old', initialStep: 'x', nodes: [] });
    const renamed = await service.save(OWNER, 'other', EXAMPLE_PROCEDURE);

    expect(broken.saved).toBe(false);
    expect(old.problems[0]?.message).toMatch(/needs "schema": 2/);
    expect(renamed).toEqual({ saved: false, problems: [{ severity: 'error', message: 'this procedure is "quick-answer", not "other"' }] });
    expect((await service.list(OWNER)).procedures.some((p) => p.mine)).toBe(false);
  });

  it('saves a procedure written as builder code, placing nodes the code did not position, and says where code is wrong', async () => {
    const service = serviceOn(memoryDatabase());
    const code = procedureToBuilderCode({ ...RESEARCH_V2, id: 'from-code', name: 'From code' }, { catalogue: builtInCatalogue(), groups: BUILT_IN_GROUPS })
      .replace(/\n  p\.layout\(\{[\s\S]*?\n  \}\)\n/, '\n');

    const saved = await service.saveBuilderCode(OWNER, 'from-code', code);
    const broken = await service.saveBuilderCode(OWNER, 'from-code', code.replace("turn.on('answered', answered)", "turn.on('answerd', answered)"));
    const escaping = await service.saveBuilderCode(OWNER, 'from-code', code.replace('(p) => {', '(p) => {\n  process.exit(1)'));
    const silent = await service.saveBuilderCode(OWNER, 'from-code', undefined);

    expect(saved).toMatchObject({ saved: true, procedure: { id: 'from-code', name: 'From code', version: '1', start: 'provision' } });
    expect(saved.saved && saved.procedure.nodes.map((node) => node.id)).toEqual(RESEARCH_V2.nodes.map((node) => node.id));
    expect(broken.saved).toBe(false);
    expect(broken.problems[0]?.message).toMatch(/^line \d+, column \d+: Model Turn "turn" has no exit called "answerd"/);
    expect(escaping.problems[0]?.message).toContain('"process" is not declared');
    expect(silent).toEqual({ saved: false, problems: [{ severity: 'error', message: 'send the builder code as "code"' }] });
  });

  it('keeps the places of nodes a person already placed when builder code is saved again', async () => {
    const service = serviceOn(memoryDatabase());
    const code = procedureToBuilderCode({ ...RESEARCH_V2, id: 'from-code', name: 'From code' }, { catalogue: builtInCatalogue(), groups: BUILT_IN_GROUPS });
    await service.saveBuilderCode(OWNER, 'from-code', code);
    const again = await service.saveBuilderCode(OWNER, 'from-code', code);
    expect(again).toMatchObject({ saved: true, procedure: { version: '2' } });
  });

  it('reports each model\'s track record on a procedure, and only the caller\'s own runs', async () => {
    const db = memoryDatabase();
    const effort = (runId: string, ownerId: string, rounds: number) => db.engine.saveRunEffort({
      runId, ownerId, agentSlug: 'research', procedureId: 'research', procedureVersion: '2', modelKey: 'tabby', modelLabel: 'Tabby',
      outcome: 'ok', rounds, toolCalls: 2, totalTokens: 900, childRuns: 0, longestReply: 0, cappedAt: 0, steps: 12, wallClockMs: 30_000, ask: 'q', limits: {},
      finishedAt: `2026-09-17T00:00:0${runId.slice(-1)}.000Z`,
    });
    for (const [index, rounds] of [3, 4, 4, 5, 6].entries()) await effort(`run-${index}`, OWNER, rounds);
    await effort('run-9', 'someone-else', 90);

    expect(await serviceOn(db).trackRecords(OWNER, 'research')).toEqual([objectWith({
      modelKey: 'tabby', runs: 5, successes: 5, typical: objectWith({ rounds: 6 }), limits: objectWith({ maxRounds: 9 }),
    })]);
  });

  it('saves a procedure that uses a published operation of the caller\'s, serves it back readable, and refuses it once that extension is off', async () => {
    const db = memoryDatabase();
    const extensions = new ExtensionService({ store: db.engine, installed: INSTALLED_EXTENSIONS, catalogue: platformCatalogue, sharedGroups: platformGroups });
    const published = (ownerId: string) => extensions.groups(ownerId);
    const service = serviceOn(db, {
      procedures: createProcedureStore({ sources: { list: (ownerId) => db.engine.getProcedures(ownerId) }, published }),
      known: async () => ({ tools: new Set(), agents: new Set() }),
      hidden: (ownerId) => extensions.hidden(ownerId),
      published,
    });
    const shout = defineGroup('shout', {
      title: 'Shout', describe: 'Passes it on.',
      inputs: { text: { type: 'text', describe: 'What to say.', required: true } },
      outputs: {},
      exits: { done: { describe: 'Said.' }, quiet: { describe: 'Nothing said.' } },
    }, (g) => {
      const said = g.condition('said', { value: g.inputs.text }, { expression: 'not empty(value)' });
      g.start(said);
      said.on('true', g.exits.done);
      said.on('false', g.exits.quiet);
      g.layout({ said: [0, 0] });
    });
    await extensions.create(OWNER, { id: 'loud', title: 'Loud' });
    await extensions.publish(OWNER, 'loud', 'shout', shout);
    const greeter = {
      schema: PROCEDURE_SCHEMA, id: 'greeter', version: '1', name: 'Greeter', describe: 'greets', budget: {}, start: 'shout',
      nodes: [
        { id: 'hello', kind: 'text', settings: { text: 'hi' }, position: { x: 0, y: 0 } },
        { id: 'shout', kind: 'group', group: 'loud.shout@1', settings: {}, position: { x: 260, y: 0 } },
        { id: 'done', kind: 'finish', settings: { outcome: 'ok' }, position: { x: 520, y: 0 } },
      ],
      wires: [{ from: { node: 'hello', socket: 'text' }, to: { node: 'shout', socket: 'text' } }],
      flow: [{ from: 'shout', exit: 'done', to: 'done' }, { from: 'shout', exit: 'quiet', to: 'done' }],
      groups: [],
    };

    expect((await service.save(OWNER, 'greeter', greeter)).saved).toBe(true);
    const listed = await service.list(OWNER);
    expect(listed.procedures.map((procedure) => procedure.id)).toContain('greeter');
    expect(listed.unreadable).toEqual([]);

    await extensions.setEnabled(OWNER, 'loud', false);
    const refused = await service.save(OWNER, 'greeter', greeter);
    expect(refused.saved).toBe(false);
    expect(JSON.stringify(refused.problems)).toMatch(/loud.shout@1, from an extension that is switched off/);
    expect(JSON.stringify(await service.check(OWNER, greeter))).toMatch(/switched off/);
  });
});

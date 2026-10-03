import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryDB } from '../lib/memory-db.js';
import { ExtensionService } from './ExtensionService.js';
import { INSTALLED_EXTENSIONS, platformCatalogue, platformGroups } from '../extensions/installed.js';
import { PROCEDURE_SCHEMA, defineGroup, type Procedure } from '@koala/agent-engine/procedure';
import type { ProcedureSource } from '../lib/procedure-source.js';

let db: MemoryDB;
let service: ExtensionService;

beforeEach(async () => {
  db = new MemoryDB();
  await db.init();
  service = new ExtensionService({ store: db, installed: INSTALLED_EXTENSIONS, now: () => 'now' });
});

describe('an owner\'s extensions', () => {
  it('are all on until the owner switches one off, and the platform says it is always on', async () => {
    const states = await service.list('u1');
    expect(states.map((state) => [state.extension.id, state.enabled, state.alwaysOn])).toEqual([['platform', true, true], ['grove', true, false]]);
  });

  it('switch off for that owner alone, hiding what the extension brings, and back on again', async () => {
    const off = await service.setEnabled('u1', 'grove', false);
    expect(off.ok && off.value.find((state) => state.extension.id === 'grove')?.enabled).toBe(false);
    expect((await service.hidden('u1')).agents.has('grove')).toBe(true);
    expect((await service.hidden('u1')).operations.has('grove.open-tree')).toBe(true);
    expect((await service.hidden('u2')).agents.size).toBe(0);
    expect(await db.getExtensionSettings('u1')).toEqual({ ownerId: 'u1', disabled: ['grove'], updatedAt: 'now' });

    await service.setEnabled('u1', 'grove', true);
    expect((await service.hidden('u1')).agents.size).toBe(0);
  });

  it('refuse to switch off the platform, and know no extension that is not installed', async () => {
    expect(await service.setEnabled('u1', 'platform', false)).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/cannot be switched off/) });
    expect(await service.setEnabled('u1', 'ghost', false)).toMatchObject({ ok: false, status: 404 });
  });
});

describe('an extension of the owner\'s own', () => {
  const shout = (exitName = 'done') => defineGroup('shout', {
    title: 'Shout',
    describe: 'Says the text louder.',
    inputs: { text: { type: 'text', describe: 'What to say.', required: true }, environment: { type: 'environment', describe: 'Where the code runs.', required: true } },
    outputs: { loud: { type: 'any', describe: 'The text, louder.' } },
    exits: { [exitName]: { describe: 'It was said.' }, empty: { describe: 'There was nothing to say.' } },
  }, (g) => {
    const upper = g.code('upper', { text: g.inputs.text, environment: g.inputs.environment }, {
      body: 'return { loud: String(inputs.text).toUpperCase() }',
      inputs: [{ name: 'text', type: 'text' }],
      outputs: [{ name: 'loud', type: 'any' }],
    });
    const said = g.condition('said', { value: upper.loud! }, { expression: 'not empty(value)' });
    g.start(said);
    said.on('true', (g.exits as unknown as Record<string, never>)[exitName]!);
    said.on('false', g.exits.empty);
    g.output('loud', upper.loud!);
    g.layout({ upper: [0, 0], said: [260, 0] });
  });

  const using = (version: number): ProcedureSource => {
    const procedure: Procedure = {
      schema: PROCEDURE_SCHEMA, id: 'greeter', version: '1', name: 'Greeter', describe: 'greets loudly', budget: {},
      start: 'provision',
      nodes: [
        { id: 'provision', kind: 'provision-sandbox', settings: {}, position: { x: 0, y: 160 } },
        { id: 'hello', kind: 'text', settings: { text: 'hello' }, position: { x: 0, y: 0 } },
        { id: 'shout', kind: 'group', group: `loud.shout@${version}`, settings: {}, position: { x: 260, y: 0 } },
        { id: 'done', kind: 'finish', settings: { outcome: 'ok' }, position: { x: 520, y: 0 } },
        { id: 'silent', kind: 'finish', settings: { outcome: 'ok' }, position: { x: 520, y: 160 } },
        { id: 'unavailable', kind: 'finish', settings: { outcome: 'failed' }, position: { x: 260, y: 320 } },
      ],
      wires: [
        { from: { node: 'hello', socket: 'text' }, to: { node: 'shout', socket: 'text' } },
        { from: { node: 'provision', socket: 'environment' }, to: { node: 'shout', socket: 'environment' } },
        { from: { node: 'shout', socket: 'loud' }, to: { node: 'done', socket: 'result' } },
      ],
      flow: [{ from: 'provision', exit: 'ready', to: 'shout' }, { from: 'provision', exit: 'unavailable', to: 'unavailable' }, { from: 'shout', exit: 'done', to: 'done' }, { from: 'shout', exit: 'empty', to: 'silent' }],
      groups: [],
    };
    return { id: 'greeter', ownerId: 'u1', version: '1', source: JSON.stringify(procedure), updatedAt: 'then' };
  };

  beforeEach(() => {
    service = new ExtensionService({
      store: db,
      installed: INSTALLED_EXTENSIONS,
      catalogue: platformCatalogue,
      sharedGroups: platformGroups,
      owned: async () => ({ agents: new Set(['loud-agent']), tools: new Set(['loud_tool']), procedures: new Set(['greeter']) }),
      now: () => 'now',
    });
  });

  it('is created beside the installed ones, can be switched off, and bundles only the owner\'s own things', async () => {
    expect((await service.create('u1', { id: 'loud', title: 'Loud' })).ok).toBe(true);
    expect((await service.create('u1', { id: 'grove', title: 'Mine' }))).toMatchObject({ ok: false, error: expect.stringMatching(/already an extension/) });

    expect(await service.update('u1', 'loud', { personas: ['koala'] })).toMatchObject({ ok: false, error: 'koala is not agents of your own' });
    expect((await service.update('u1', 'loud', { personas: ['loud-agent'], tools: ['loud_tool'], procedures: ['greeter'] })).ok).toBe(true);

    const states = await service.list('u1');
    expect(states.find((state) => state.extension.id === 'loud')).toMatchObject({ enabled: true, authored: true });
    expect(await service.list('u2')).toHaveLength(2);

    await service.setEnabled('u1', 'loud', false);
    const hidden = await service.hidden('u1');
    expect([...hidden.agents]).toEqual(['loud-agent']);
    expect([...hidden.tools]).toEqual(['loud_tool']);
  });

  it('publishes a group as an operation at version 1, and refuses one that does not check', async () => {
    await service.create('u1', { id: 'loud', title: 'Loud' });

    expect(await service.publish('u1', 'loud', 'shout', shout())).toMatchObject({ ok: true, value: { id: 'loud.shout@1', version: 1, moved: [] } });
    expect((await service.groups('u1')).map((group) => group.id)).toEqual(['loud.shout@1']);

    const broken = { ...shout(), start: 'nowhere' };
    expect(await service.publish('u1', 'loud', 'mumble', broken)).toMatchObject({ ok: false, status: 400, error: expect.stringMatching(/does not check/) });
  });

  it('moves every procedure using an operation onto its new version when it is saved, keeping the old versions', async () => {
    await service.create('u1', { id: 'loud', title: 'Loud' });
    await service.publish('u1', 'loud', 'shout', shout());
    await db.saveProcedure(using(1));

    expect(await service.publish('u1', 'loud', 'shout', shout())).toMatchObject({ ok: true, value: { id: 'loud.shout@2', version: 2, moved: ['greeter'] } });
    const saved = JSON.parse((await db.getProcedures('u1')).find((source) => source.id === 'greeter')!.source) as Procedure;
    expect(saved.nodes.find((node) => node.id === 'shout')?.group).toBe('loud.shout@2');
    expect((await service.groups('u1')).map((group) => group.id)).toEqual(['loud.shout@1', 'loud.shout@2']);
  });

  it('refuses a version that would break a procedure using it, and says which', async () => {
    await service.create('u1', { id: 'loud', title: 'Loud' });
    await service.publish('u1', 'loud', 'shout', shout());
    await db.saveProcedure(using(1));

    expect(await service.publish('u1', 'loud', 'shout', shout('said'))).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/would break greeter/) });
    expect(JSON.parse((await db.getProcedures('u1'))[0]!.source).nodes.find((node: { id: string }) => node.id === 'shout').group).toBe('loud.shout@1');
  });

  it('will not remove an operation, or the extension, while a procedure uses it', async () => {
    await service.create('u1', { id: 'loud', title: 'Loud' });
    await service.publish('u1', 'loud', 'shout', shout());
    await db.saveProcedure(using(1));

    expect(await service.removeOperation('u1', 'loud', 'shout')).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/greeter still uses it/) });
    expect(await service.remove('u1', 'loud')).toMatchObject({ ok: false, status: 409 });
  });
});

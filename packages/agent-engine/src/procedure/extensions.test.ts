import { describe, it, expect } from 'vitest';
import { catalogueFor, extensionProblems, groupsFor, type EngineExtension } from './extensions.js';
import { HOST_OP_KIND, type HostOperation } from './host-operations.js';
import { definitionFor } from './definition.js';
import { BUILT_IN_GROUPS } from './seeds/groups.js';
import { PROCEDURE_SCHEMA, type GroupDefinition, type Procedure } from './schema.js';
import type { Persona } from '../agent/agent.js';

const operation = (name: string): HostOperation => ({
  name,
  title: 'Tidy',
  group: 'Storage',
  describe: 'Tidies the shared folder.',
  inputs: [],
  outputs: [],
  exits: [{ name: 'done', describe: 'It is tidy.' }],
  settings: { type: 'object', properties: {} },
  summary: 'tidies',
  idempotent: true,
});

const place = (id: string, kind: string, settings: Record<string, unknown>) => ({ id, kind, settings, position: { x: 0, y: 0 } });

const procedure = (id: string, nodes = [place('done', 'finish', { outcome: 'ok' })]): Procedure => ({
  schema: PROCEDURE_SCHEMA, id, version: '1', name: id, describe: id, budget: {}, start: nodes[0]!.id, nodes, wires: [], flow: [], groups: [],
});

const group = (id: string): GroupDefinition => ({
  id, title: 'Shelve', describe: 'Shelves an item.', inputs: [], outputs: [], exits: [{ name: 'done', describe: 'Shelved.' }],
  start: 'note', nodes: [place('note', 'text', { text: 'shelved' })], wires: [], flow: [],
} as never);

const persona = (slug: string, over: Partial<Persona> = {}): Persona => ({
  slug, name: slug, description: slug, version: '1', prompt: 'p', guidance: 'g', returns: 'r', failures: [], procedure: 'storage-run', tools: [], environment: {}, ...over,
});

const storage: EngineExtension = {
  id: 'storage',
  title: 'Storage',
  describe: 'Keeps things.',
  version: '1',
  operations: [operation('storage.tidy')],
  groups: [group('storage.shelve')],
  tools: [{ name: 'list_shelves' } as never],
  personas: [persona('archivist', { tools: ['list_shelves'] })],
  procedures: [procedure('storage-run', [place('tidy', HOST_OP_KIND, { operation: 'storage.tidy' }), place('done', 'finish', { outcome: 'ok' })])].map((entry) => ({
    ...entry,
    flow: [{ from: 'tidy', exit: 'done', to: 'done' }],
  })),
};

describe('extensions compose into one node language', () => {
  it('puts every extension\'s operations in the catalogue and its groups beside the built-in ones', () => {
    const catalogue = catalogueFor([storage]);
    expect(definitionFor(catalogue, { kind: HOST_OP_KIND, settings: { operation: 'storage.tidy' } })?.title).toBe('Tidy');
    expect(groupsFor([storage]).map((entry) => entry.id)).toEqual([...BUILT_IN_GROUPS.map((entry) => entry.id), 'storage.shelve']);
  });

  it('finds nothing wrong with a well-formed extension', () => {
    expect(extensionProblems([storage])).toEqual([]);
  });

  it('keeps each extension to its own namespace', () => {
    const stray: EngineExtension = { ...storage, id: 'notes', operations: [operation('storage.sweep')], groups: [group('shelve')], personas: [], procedures: [], tools: [] };
    expect(extensionProblems([stray])).toEqual(expect.arrayContaining([
      'extension "notes" offers operation "storage.sweep", which is not named under "notes."',
      'extension "notes" offers group "shelve", which is not named under "notes."',
    ]));
  });

  it('refuses two of anything with the same name, and a requirement that is not installed', () => {
    const twin: EngineExtension = { ...storage, requires: ['ledger'] };
    expect(extensionProblems([storage, twin])).toEqual(expect.arrayContaining([
      'extension "storage" is installed twice',
      'operation "storage.tidy" is offered twice',
      'group "storage.shelve" is offered twice',
      'agent "archivist" is offered twice',
      'extension "storage" needs "ledger", which is not installed',
    ]));
  });

  it('lets an authored extension offer groups but not operations, which only the platform can implement', () => {
    expect(extensionProblems([storage], { authored: new Set(['storage']) })).toContain(
      'extension "storage" declares operations, which only the platform can implement — an authored operation is a group',
    );
  });

  it('refuses a seeded procedure that does not check, and an agent naming what nothing offers', () => {
    const broken: EngineExtension = {
      ...storage,
      procedures: [procedure('storage-run', [place('tidy', HOST_OP_KIND, { operation: 'storage.missing' })])],
      personas: [persona('archivist', { tools: ['nowhere'], agents: ['ghost'], procedure: 'absent' })],
    };
    const problems = extensionProblems([broken]);
    expect(problems.some((problem) => problem.startsWith('extension "storage" seeds procedure "storage-run", which does not check'))).toBe(true);
    expect(problems).toEqual(expect.arrayContaining([
      'extension "storage" seeds agent "archivist" on procedure "absent", which nothing offers',
      'extension "storage" seeds agent "archivist" with tool "nowhere", which nothing offers',
      'extension "storage" seeds agent "archivist" delegating to "ghost", which nothing offers',
    ]));
  });

  it('counts what the engine itself offers when checking what an extension names', () => {
    const leaning: EngineExtension = { ...storage, personas: [persona('archivist', { procedure: 'engine-run', tools: ['save_procedure'], agents: ['agent-builder'] })] };
    expect(extensionProblems([leaning], { procedures: [procedure('engine-run')], tools: ['save_procedure'], personas: ['agent-builder'] })).toEqual([]);
  });
});

describe('a published group in builder code', () => {
  it('is written by its id and read back to the same group, versioned id and all', async () => {
    const { procedureToBuilderCode, builderCodeToProcedure } = await import('./builder/index.js');
    const published = { ...group('my-storage.shelve@2') };
    const using: Procedure = {
      ...procedure('uses-shelve'),
      start: 'shelve',
      nodes: [{ id: 'shelve', kind: 'group', group: 'my-storage.shelve@2', settings: {}, position: { x: 0, y: 0 } }, place('done', 'finish', { outcome: 'ok' })],
      flow: [{ from: 'shelve', exit: 'done', to: 'done' }],
    };
    const options = { catalogue: catalogueFor([]), groups: [...groupsFor([]), published] };

    const code = procedureToBuilderCode(using, options);
    expect(code).toContain('p.groups["my-storage.shelve@2"](');
    const read = builderCodeToProcedure(code, options);
    expect(read.ok && read.procedure.nodes.find((node) => node.id === 'shelve')).toMatchObject({ kind: 'group', group: 'my-storage.shelve@2' });
  });
});

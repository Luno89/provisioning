import { describe, it, expect } from 'vitest';
import { builtInCatalogue } from './nodes/index.js';
import { definitionFor, NodeCatalogueError } from './definition.js';
import { HOST_OP_KIND, fillSummary, type HostOperation } from './host-operations.js';
import { checkProcedure } from './validate.js';
import { runProcedure } from './interpreter.js';
import { scriptedExecutor } from '../../testing/procedure-nodes.js';
import { procedureBuilder } from './builder/index.js';
import { BUILT_IN_GROUPS } from './seeds/groups.js';
import { PROCEDURE_SCHEMA, type Procedure } from './schema.js';

const PREPARE: HostOperation = {
  name: 'storage.prepare-folders',
  title: 'Prepare Folders',
  group: 'Storage',
  describe: 'Gives each item a folder of the shared workspace.',
  inputs: [{ name: 'entries', type: 'any', describe: 'The entries to prepare.', required: true }],
  outputs: [{ name: 'items', type: 'json', describe: 'One item per prepared entry.' }],
  exits: [{ name: 'ready', describe: 'Every entry has a folder.' }, { name: 'conflict', describe: 'A folder could not be made.' }],
  settings: { type: 'object', properties: { prefix: { type: 'string', title: 'Prefix', default: 'item/' } } },
  summary: 'prepares folders under {{prefix}}',
  idempotent: true,
};

const place = (id: string, kind: string, settings: Record<string, unknown>) => ({ id, kind, settings, position: { x: 0, y: 0 } });

const preparing = (settings: Record<string, unknown>): Procedure => ({
  schema: PROCEDURE_SCHEMA,
  id: 'prep',
  version: '1',
  name: 'Prep',
  describe: 'prepares',
  budget: {},
  start: 'prepare',
  nodes: [
    place('leaves', 'text', { text: '[]' }),
    place('prepare', HOST_OP_KIND, settings),
    place('done', 'finish', { outcome: 'ok' }),
    place('clash', 'finish', { outcome: 'failed', reason: 'a folder clashed' }),
  ],
  wires: [{ from: { node: 'leaves', socket: 'text' }, to: { node: 'prepare', socket: 'entries' } }],
  flow: [{ from: 'prepare', exit: 'ready', to: 'done' }, { from: 'prepare', exit: 'conflict', to: 'clash' }],
  groups: [],
});

describe('a platform operation, declared as data', () => {
  const catalogue = builtInCatalogue([PREPARE]);

  it('takes its sockets, exits, settings, title and summary from the operation it names', () => {
    const shaped = definitionFor(catalogue, { kind: HOST_OP_KIND, settings: { operation: PREPARE.name, prefix: 'work/' } })!;

    expect(shaped.title).toBe('Prepare Folders');
    expect(shaped.inputs.map((socket) => socket.name)).toEqual(['entries']);
    expect(shaped.outputs.map((socket) => socket.name)).toEqual(['items']);
    expect(shaped.exits.map((exit) => exit.name)).toEqual(['ready', 'conflict']);
    expect(Object.keys(shaped.settings.properties)).toEqual(['operation', 'prefix']);
    expect(shaped.idempotent).toBe(true);
    expect(shaped.summarize({ operation: PREPARE.name, prefix: 'work/' })).toBe('prepares folders under work/');
  });

  it('checks clean when it names an operation and wires what it needs', () => {
    const errors = checkProcedure(preparing({ operation: PREPARE.name }), { catalogue, groups: BUILT_IN_GROUPS }).filter((problem) => problem.severity === 'error');
    expect(errors).toEqual([]);
  });

  it('is refused when it names an operation the platform does not offer', () => {
    const problems = checkProcedure(preparing({ operation: 'storage.nothing' }), { catalogue, groups: BUILT_IN_GROUPS });
    expect(problems.map((problem) => problem.message).join('\n')).toMatch(/"storage\.nothing" is not an operation this platform offers/);
  });

  it('is refused when one of the operation\'s own settings is wrong', () => {
    const problems = checkProcedure(preparing({ operation: PREPARE.name, prefix: 7 }), { catalogue, groups: BUILT_IN_GROUPS });
    expect(problems.map((problem) => problem.message).join('\n')).toMatch(/prefix has to be text/);
  });

  it('leaves through the exits its operation declares when it runs', async () => {
    const executor = scriptedExecutor(
      { [HOST_OP_KIND]: ({ node }) => ({ exit: node.settings.operation === PREPARE.name ? 'conflict' : 'done', outputs: { items: [] } }) },
      { text: () => ({ outputs: { text: '[]' } }) },
    );

    const result = await runProcedure({
      procedure: preparing({ operation: PREPARE.name }),
      catalogue,
      groups: BUILT_IN_GROUPS,
      executor,
      identity: { runId: 'run-1', depth: 0, agentId: 'worker', loopId: 'prep', loopVersion: '1', trigger: 'user' },
      launch: { ownerId: 'user-1' },
    });

    expect(result).toMatchObject({ outcome: 'failed', reason: 'a folder clashed' });
  });

  it('refuses a catalogue built from a malformed declaration', () => {
    expect(() => builtInCatalogue([{ ...PREPARE, name: 'Not A Name', exits: [] }])).toThrow(NodeCatalogueError);
  });

  it('can be placed from builder code, with its declared sockets and exits', () => {
    const built = procedureBuilder({ catalogue, groups: BUILT_IN_GROUPS })({ id: 'prep', version: '1', name: 'Prep', describe: 'prepares', budget: {} }, (p) => {
      const leaves = p.text('leaves', {}, { text: '[]' });
      const prepare = p.hostOp('prepare', { entries: leaves.text }, { operation: PREPARE.name });
      const done = p.finish('done', { result: prepare.items! }, { outcome: 'ok' });
      prepare.on('ready', done);
      p.start(prepare);
      p.layout({ leaves: [0, 0], prepare: [260, 0], done: [520, 0] });
    }).procedure;

    expect(built.wires).toContainEqual({ from: { node: 'prepare', socket: 'items' }, to: { node: 'done', socket: 'result' } });
    expect(built.flow).toContainEqual({ from: 'prepare', exit: 'ready', to: 'done' });
  });

  it('fills a summary from the settings, and marks one that is not set', () => {
    expect(fillSummary('runs {{agent}} {{count}} times', { agent: 'judge', count: 3 })).toBe('runs judge 3 times');
    expect(fillSummary('under {{prefix}}', {})).toBe('under —');
  });
});

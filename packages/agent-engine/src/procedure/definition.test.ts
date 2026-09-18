import { describe, it, expect } from 'vitest';
import { createNodeCatalogue, defineNode, NodeCatalogueError, type NodeDefinition } from './definition.js';
import { NO_SETTINGS } from './settings-schema.js';
import { TEST_NODES, echoNode, noteNode } from '../../testing/procedure-nodes.js';

const valid = (over: Partial<NodeDefinition>): NodeDefinition => defineNode({
  kind: 'sample',
  title: 'Sample',
  category: 'control',
  describe: 'A sample node',
  role: 'step',
  inputs: [],
  outputs: [],
  exits: [{ name: 'done', describe: 'Always' }],
  settings: NO_SETTINGS,
  runs: 'workflow',
  idempotent: true,
  summarize: () => 'sample',
  ...over,
});

const problemsOf = (definitions: NodeDefinition[]): readonly string[] => {
  try {
    createNodeCatalogue(definitions);
  } catch (err) {
    if (err instanceof NodeCatalogueError) return err.problems;
    throw err;
  }
  return [];
};

describe('the node catalogue', () => {
  it('finds a definition by kind', () => {
    const catalogue = createNodeCatalogue(TEST_NODES);

    expect(catalogue.get('echo')).toBe(echoNode);
    expect(catalogue.get('nothing')).toBeUndefined();
  });

  it('lists definitions grouped by category, then by title, for the palette', () => {
    const listed = createNodeCatalogue(TEST_NODES).list().map((definition) => `${definition.category}/${definition.title}`);

    expect(listed).toEqual([...listed].sort());
    expect(listed[0]).toBe('context/Join Text');
    expect(createNodeCatalogue(TEST_NODES).list()).toContain(noteNode);
  });

  it('refuses two definitions of the same kind', () => {
    expect(problemsOf([valid({}), valid({ title: 'Other' })])).toEqual(['"sample" is defined twice']);
  });

  it('refuses a value node that tries to decide where the run goes', () => {
    expect(problemsOf([valid({ role: 'value', outputs: [{ name: 'text', type: 'text', describe: 'Text' }] })]))
      .toEqual(['"sample" is a value node, so it cannot have exits — only steps decide where to go next']);
  });

  it('refuses a value node that produces nothing', () => {
    expect(problemsOf([valid({ role: 'value', exits: [] })]))
      .toEqual(['"sample" is a value node with no outputs, so nothing could ever read it']);
  });

  it('reports every problem with a definition at once, so they can all be fixed together', () => {
    expect(problemsOf([valid({
      kind: 'Bad Kind',
      describe: ' ',
      inputs: [
        { name: 'text', type: 'text', describe: 'One' },
        { name: 'text', type: 'text', describe: 'Two' },
        { name: 'bad-name', type: 'nope' as never, describe: '' },
      ],
      exits: [{ name: 'done', describe: 'Always' }, { name: 'done', describe: 'Again' }],
    })])).toEqual([
      '"Bad Kind" has to be lower-case words joined by dashes',
      '"Bad Kind" does not describe what it does',
      '"Bad Kind" has a socket named "bad-name", which is not a plain camelCase name',
      '"Bad Kind" has a socket "bad-name" of unknown type "nope"',
      '"Bad Kind" does not describe its socket "bad-name"',
      '"Bad Kind" has two inputs called "text"',
      '"Bad Kind" has two exits called "done"',
    ]);
  });

  it('keeps "group" for groups', () => {
    expect(problemsOf([valid({ kind: 'group' })])).toEqual(['"group" is reserved for groups']);
  });

  it('accepts every fixture node the other tests rely on', () => {
    expect(problemsOf(TEST_NODES)).toEqual([]);
  });
});

import { describe, it, expect } from 'vitest';
import { BUILT_IN_DEFINITIONS, WORKFLOW_IMPLEMENTATIONS, builtInCatalogue, cappedText, truncateText, text as textNode } from './nodes/index.js';
import { finish } from './nodes/control.js';
import { createNodeCatalogue } from './definition.js';
import { BUILT_IN_GROUPS } from './seeds/groups.js';
import { describeProcedureFormat } from './source.js';
import { BUILDER_DECLARATIONS } from './builder/declarations.generated.js';
import { procedureBuilder } from './builder/index.js';
import { runProcedure } from './interpreter.js';
import { createNodeExecutor } from './implementation.js';
import type { NodeTrace } from './interpreter.js';

const KIND = 'truncate-text';
const catalogue = builtInCatalogue();

describe('a node added by the recipe alone shows up everywhere a node is offered', () => {
  it('is in the catalogue the palette is built from', () => {
    expect(catalogue.get(KIND)).toBeDefined();
    expect(BUILT_IN_DEFINITIONS.map((definition) => definition.kind)).toContain(KIND);
  });

  it('carries the describe text the inspector and the palette show', () => {
    expect(catalogue.get(KIND)?.describe).toContain('crowd everything else out of the prompt');
    expect(catalogue.get(KIND)?.title).toBe('Truncate Text');
  });

  it('is in the syntax description the agent-builder is given', () => {
    const syntax = describeProcedureFormat(catalogue, BUILT_IN_GROUPS);

    expect(syntax).toContain(KIND);
    expect(syntax).toContain('crowd everything else out of the prompt');
  });

  it('is in the generated builder types, as a method with its sockets', () => {
    expect(BUILDER_DECLARATIONS).toContain('truncateText');
    expect(BUILDER_DECLARATIONS).toContain('maxChars');
  });

  it('can be written in builder code and read back as a procedure', () => {
    const built = procedureBuilder({ catalogue, groups: BUILT_IN_GROUPS })({
      id: 'capping', version: '1', name: 'Capping', describe: 'Caps a piece of text.', budget: {},
    }, (p) => {
      const long = p.text('long', {}, { text: 'x'.repeat(50) });
      const capped = p.truncateText('capped', { text: long.text }, { maxChars: 100, keep: 'start' });
      const done = p.finish('done', { result: capped.text }, { outcome: 'ok' });

      p.start(done);
      p.layout({ long: [0, 0], capped: [260, 0], done: [520, 0] });
    }).procedure;

    expect(built.nodes.find((node) => node.id === 'capped')?.kind).toBe(KIND);
  });

  it('runs, and its trace says what went in and came out', async () => {
    const procedure = procedureBuilder({ catalogue, groups: BUILT_IN_GROUPS })({
      id: 'capping', version: '1', name: 'Capping', describe: 'Caps a piece of text.', budget: {},
    }, (p) => {
      const long = p.text('long', {}, { text: 'x'.repeat(50) });
      const capped = p.truncateText('capped', { text: long.text }, { maxChars: 10, keep: 'start' });
      const done = p.finish('done', { result: capped.text }, { outcome: 'ok' });

      p.start(done);
      p.layout({ long: [0, 0], capped: [260, 0], done: [520, 0] });
    }).procedure;

    const used = [textNode, truncateText, finish];
    const narrow = createNodeCatalogue(used.map((node) => node.definition));
    const traces: NodeTrace[] = [];
    const result = await runProcedure({
      procedure,
      catalogue: narrow,
      groups: [],
      executor: createNodeExecutor(narrow, WORKFLOW_IMPLEMENTATIONS.filter((implementation) => used.some((node) => node.definition.kind === implementation.kind))),
      identity: { runId: 'run-1', depth: 0, agentId: 'koala', loopId: 'capping', loopVersion: '1', trigger: 'user' },
      launch: { ownerId: 'user-1' },
      inputs: {},
      onTrace: (trace) => traces.push(trace),
    });

    const trace = traces.find((entry) => entry.kind === KIND);

    expect(result.outcome).toBe('ok');
    expect((trace?.outputs as { text?: string } | undefined)?.text).toBe(`${'x'.repeat(10)}\n…[40 characters truncated from the end]`);
  });

  it('needed no implementation anywhere but its own definition', () => {
    expect(truncateText.implementation).toBeDefined();
    expect(WORKFLOW_IMPLEMENTATIONS.filter((implementation) => implementation.kind === KIND)).toHaveLength(1);
  });
});

describe('capping a piece of text', () => {
  it('leaves text that already fits alone', () => {
    expect(cappedText('short', 100, 'start')).toBe('short');
  });

  it('keeps the start, saying how much went', () => {
    expect(cappedText('abcdefghij', 4, 'start')).toBe('abcd\n…[6 characters truncated from the end]');
  });

  it('keeps the end when asked, for output where the error is last', () => {
    expect(cappedText('abcdefghij', 4, 'end')).toBe('…[6 characters truncated from the start]\nghij');
  });

  it('has nothing to cap when nothing was wired', () => {
    expect(cappedText('', 10, 'start')).toBe('');
  });
});

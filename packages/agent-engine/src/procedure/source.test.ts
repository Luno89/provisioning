import { describe, it, expect } from 'vitest';
import { describeProcedureFormat, EXAMPLE_PROCEDURE, formatProcedureProblems, readAndCheckProcedure, readProcedure } from './source.js';
import { builtInCatalogue } from './nodes/index.js';
import { BUILT_IN_GROUPS } from './seeds/groups.js';
import { BUILT_IN_PROCEDURES, TOOL_ROUNDS_V2 } from './seeds/procedures.js';

const catalogue = builtInCatalogue();

describe('reading a procedure', () => {
  it('reads every built-in back from its own JSON unchanged', () => {
    for (const procedure of BUILT_IN_PROCEDURES) {
      const read = readProcedure(JSON.stringify(procedure));
      expect(read.ok && read.procedure).toEqual(procedure);
    }
  });

  it('fills what a hand-written procedure leaves out: positions, settings, wires, groups', () => {
    const read = readProcedure({ schema: 2, id: 'tiny', start: 'end', nodes: [{ id: 'end', kind: 'finish' }] });

    expect(read.ok && read.procedure).toEqual({
      schema: 2, id: 'tiny', version: '1', name: 'tiny', describe: '', budget: {}, start: 'end',
      nodes: [{ id: 'end', kind: 'finish', settings: {}, position: { x: 0, y: 0 } }],
      wires: [], flow: [], groups: [],
    });
  });

  it('refuses something that is not JSON, or not this format', () => {
    expect(readProcedure('{ nope')).toMatchObject({ ok: false, problems: [{ message: expect.stringMatching(/^this is not valid JSON/) }] });
    expect(readProcedure({ id: 'old', version: '1', initialStep: 'think', nodes: [] })).toMatchObject({
      ok: false,
      problems: [{ message: expect.stringMatching(/needs "schema": 2/) }],
    });
  });

  it('checks what it reads, and names where each problem is', () => {
    const broken = { ...TOOL_ROUNDS_V2, flow: TOOL_ROUNDS_V2.flow.filter((entry) => entry.exit !== 'empty') };
    const checked = readAndCheckProcedure(JSON.stringify(broken), { catalogue, groups: BUILT_IN_GROUPS });

    expect(checked.ok).toBe(false);
    expect(formatProcedureProblems(checked.problems).split('\n')).toEqual([
      '- node "turn", exit "empty": can leave through "empty", but nothing says where that goes',
      '- warning: node "empty": nothing leads to this step, so it never runs',
    ]);
  });
});

describe('the format description a model is given', () => {
  const described = describeProcedureFormat(catalogue, BUILT_IN_GROUPS);

  it('lists every node kind and every group, with what connects to them', () => {
    for (const definition of catalogue.list()) expect(described).toContain(`- ${definition.kind} (${definition.role})`);
    for (const group of BUILT_IN_GROUPS) expect(described).toContain(`- "${group.id}"`);
    expect(described).toContain('exits: toolCalls, answered, truncated, empty');
    expect(described).toContain('offer: "granted" | "none" | "chosen" = "granted"');
  });

  it('teaches with an example that is itself a valid procedure', () => {
    expect(readAndCheckProcedure(EXAMPLE_PROCEDURE, { catalogue, groups: BUILT_IN_GROUPS })).toMatchObject({ ok: true, problems: [] });
    expect(described).toContain(JSON.stringify(EXAMPLE_PROCEDURE, null, 2));
  });
});

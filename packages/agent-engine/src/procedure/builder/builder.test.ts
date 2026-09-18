import { describe, it, expect } from 'vitest';
import { builtInCatalogue } from '../nodes/index.js';
import { BUILT_IN_GROUPS, MODEL_TURN } from '../seeds/groups.js';
import { BUILT_IN_PROCEDURES, SINGLE_SHOT_V2 } from '../seeds/procedures.js';
import { checkProcedure } from '../validate.js';
import type { Body, GroupDefinition, Procedure } from '../schema.js';
import { procedureToBuilderCode } from './emit.js';
import { builderCodeToProcedure } from './parse.js';

const options = { catalogue: builtInCatalogue(), groups: BUILT_IN_GROUPS };

const key = (value: unknown) => JSON.stringify(value);

function canonicalBody(body: Body) {
  const into = new Map<string, string[]>();
  for (const wire of body.wires) {
    const at = key([wire.to.node, wire.to.socket]);
    into.set(at, [...(into.get(at) ?? []), key(wire.from)]);
  }
  return {
    start: body.start,
    nodes: body.nodes,
    wires: [...into.entries()].sort(([a], [b]) => a.localeCompare(b)),
    flow: body.flow.map(key).sort(),
  };
}

function canonical(procedure: Procedure) {
  const { nodes: _nodes, wires: _wires, flow: _flow, start: _start, groups, ...rest } = procedure;
  return {
    ...rest,
    ...canonicalBody(procedure),
    groups: groups.map((group: GroupDefinition) => ({
      id: group.id,
      title: group.title,
      describe: group.describe,
      ...canonicalBody(group),
      inputs: group.inputs.map((input) => ({ ...input, to: input.to.map(key).sort() })),
      outputs: group.outputs,
      exits: group.exits,
    })),
  };
}

const roundTrip = (procedure: Procedure) => {
  const code = procedureToBuilderCode(procedure, options);
  const parsed = builderCodeToProcedure(code, options);
  if (!parsed.ok) throw new Error(`${parsed.problems.map((problem) => `${problem.line}:${problem.column} ${problem.message}`).join('\n')}\n\n${code}`);
  return { code, parsed };
};

const withOwnGroup: Procedure = {
  ...SINGLE_SHOT_V2,
  id: 'own-group',
  groups: [{ ...MODEL_TURN, id: 'my-turn', title: 'My turn' }],
  nodes: [...SINGLE_SHOT_V2.nodes, { id: 'turn', kind: 'group', group: 'my-turn', label: 'Think', notes: 'the main call', settings: {}, position: { x: 10, y: -20 } }],
  wires: [...SINGLE_SHOT_V2.wires, { from: { node: 'conversation', socket: 'messages' }, to: { node: 'turn', socket: 'messages' } }],
  flow: [...SINGLE_SHOT_V2.flow, ...['toolCalls', 'answered', 'truncated', 'empty'].map((exit) => ({ from: 'turn', exit, to: 'verdict' }))],
};

describe('writing a procedure as builder code and reading it back', () => {
  it.each(BUILT_IN_PROCEDURES.map((procedure) => [procedure.id, procedure] as const))('%s comes back exactly as it was', (_id, procedure) => {
    const { parsed } = roundTrip(procedure);

    expect(canonical(parsed.ok ? parsed.procedure : procedure)).toEqual(canonical(procedure));
    expect(parsed.ok && parsed.unplaced).toEqual([]);
  });

  it('carries a procedure\'s own groups, labels and notes through', () => {
    const { parsed } = roundTrip(withOwnGroup);

    expect(parsed.ok && canonical(parsed.procedure)).toEqual(canonical(withOwnGroup));
    expect(checkProcedure(parsed.ok ? parsed.procedure : withOwnGroup, { catalogue: options.catalogue, groups: BUILT_IN_GROUPS })
      .filter((problem) => problem.severity === 'error')).toEqual([]);
  });

  it('reads like the canvas: a const per node, wires by name, and exits with .on', () => {
    const { code } = roundTrip(SINGLE_SHOT_V2);

    expect(code).toContain("import { procedure } from '@koala/procedure-builder'");
    expect(code).toContain("const input = p.runInput('input')");
    expect(code).toContain("const conversation = p.conversation('conversation', { opening: input.message, given: input.inputs })");
    expect(code).toContain("const verdict = p.finish('verdict', { result: call.content }, { outcome: 'ok' })");
    expect(code).toContain("call.on('answered', verdict)");
    expect(code).toContain('p.cleanup(release)');
    expect(code).toContain('    input: [0, 140],');
  });
});

const source = (body: string) => `import { procedure } from '@koala/procedure-builder'

export default procedure({ id: 'check', budget: {} }, (p) => {
  const done = p.finish('done', {}, { outcome: 'ok' })
${body}
  p.start(done)
})
`;

const refusal = (code: string) => {
  const parsed = builderCodeToProcedure(code, options);
  if (parsed.ok) throw new Error('it was accepted');
  return parsed.problems[0]!;
};

describe('reading builder code without running it', () => {
  it('builds a procedure from plain builder code, placing nodes it was not told where to put', () => {
    const parsed = builderCodeToProcedure(source(''), options);

    expect(parsed).toMatchObject({ ok: true, unplaced: ['done'], procedure: { id: 'check', start: 'done', nodes: [{ id: 'done', kind: 'finish', settings: { outcome: 'ok' } }] } });
  });

  it.each([
    ['a function', "  const f = function () { return 1 }", 5, 13],
    ['a loop', "  for (const x of []) {}", 5, 3],
    ['let', "  let x = 1", 5, 3],
    ['an assignment', "  done.id = 'x'", 5, 3],
    ['a call that is not the builder\'s', "  console.log('hi')", 5, 3],
    ['reading with [ ]', "  const x = p['finish']", 5, 13],
    ['a template with a value in it', "  const x = p.text('x', {}, { text: `${1}` })", 5, 37],
    ['a spread', "  const x = p.text('x', {}, { ...{} })", 5, 31],
    ['a type annotation', "  const x = p.text('x') as never", 5, 13],
    ['reaching outside the builder', "  const x = done.constructor", 5, 18],
    ['a new', "  const x = new Date()", 5, 13],
  ])('refuses %s, saying where', (_name, line, row, column) => {
    const problem = refusal(source(line));

    expect({ line: problem.line, column: problem.column }).toEqual({ line: row, column });
  });

  it('refuses importing anything but the builder', () => {
    expect(refusal("import fs from 'fs'\n").message).toContain('only @koala/procedure-builder can be imported');
  });

  it('says what went wrong in the builder\'s own words, at the call that caused it', () => {
    const wrongExit = refusal(source("  const again = p.finish('again', {}, { outcome: 'ok' })\n  done.on('toolcall', again)"));
    const wrongSocket = refusal(source("  const turn = p.callModel('turn', { system: done.nothing })"));
    const wrongType = refusal(source("  const persona = p.persona('persona')\n  const turn = p.callModel('turn', { system: persona.persona })"));

    expect(wrongExit).toMatchObject({ line: 6, message: expect.stringContaining('has no exit called "toolcall"') });
    expect(wrongSocket.message).toContain('Finish "done" has no output or method called "nothing"');
    expect(wrongType.message).toBe('"turn.system" takes text, but persona.persona gives persona');
  });

  it('reports a syntax error with its position', () => {
    expect(refusal('export default procedure({ id: "x" }, (p) => {')).toMatchObject({ line: 1 });
  });
});

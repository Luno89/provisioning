import { describe, it, expect } from 'vitest';
import { BUILT_IN_GROUPS, MODEL_TURN, TOOL_LOOP } from './groups.js';
import { BUILT_IN_PROCEDURES, DO_ONE_TASK_V2, INTERACTIVE_CHAT_V3 } from './procedures.js';
import { builtInCatalogue } from '../nodes/index.js';
import { checkProcedure } from '../validate.js';
import { expandGroups, groupLibrary } from '../groups.js';
import { PROCEDURE_SCHEMA, type Procedure } from '../schema.js';
import { describeHandledSteps, handledTools } from '../handled.js';

const catalogue = builtInCatalogue();

describe('built-in groups', () => {
  it.each(BUILT_IN_GROUPS.map((group) => [group.id, group] as const))('%s is valid on its own, with no warnings', (_id, group) => {
    const standalone: Procedure = {
      schema: PROCEDURE_SCHEMA,
      id: `using-${group.id}`,
      version: '1',
      name: group.title,
      describe: group.describe,
      budget: { maxRounds: 1 },
      start: 'only',
      nodes: [{ id: 'only', kind: 'group', group: group.id, settings: {}, position: { x: 0, y: 0 } }],
      wires: [],
      flow: [],
      groups: [group],
    };

    const problems = checkProcedure(standalone, { catalogue }).filter((problem) => problem.group === group.id);

    expect(problems).toEqual([]);
  });

  it('builds the system prompt from its sections in a settled order', () => {
    const sections = MODEL_TURN.wires.filter((entry) => entry.to.node === 'context' && entry.to.socket === 'sections');

    expect(sections.map((entry) => entry.from.node)).toEqual(['persona', 'environment', 'around', 'toolText', 'memory', 'outputs']);
  });

  it('sizes the reply against the same system prompt and conversation it sends', () => {
    const into = (node: string, socket: string) =>
      [
        ...MODEL_TURN.wires.filter((entry) => entry.to.node === node && entry.to.socket === socket).map((entry) => `${entry.from.node}:${entry.from.socket}`),
        ...MODEL_TURN.inputs.filter((input) => input.to.some((target) => target.node === node && target.socket === socket)).map((input) => `input:${input.name}`),
      ];

    expect(into('fit', 'system')).toEqual(into('call', 'system'));
    expect(into('fit', 'messages')).toEqual(into('call', 'messages'));
    expect(into('call', 'maxTokens')).toEqual(['fit:maxTokens']);
  });

  it('lets a tool loop end three ways: ran, all refused, or kept failing', () => {
    expect(TOOL_LOOP.exits.map((exit) => exit.name)).toEqual(['done', 'refused', 'failing']);
  });
});

describe('built-in procedures', () => {
  it('remembers refusals into the saved conversation, alongside the results', () => {
    const intoResults = INTERACTIVE_CHAT_V3.wires
      .filter((wire) => wire.to.node === 'remember' && wire.to.socket === 'results')
      .map((wire) => wire.from.socket)
      .sort();

    expect(intoResults).toEqual(['refused', 'results']);
  });
  it('remembers the accumulated rounds, so a multi-round turn keeps the calls it made in the middle', () => {
    const intoRounds = INTERACTIVE_CHAT_V3.wires
      .filter((wire) => wire.to.node === 'remember' && wire.to.socket === 'rounds')
      .map((wire) => wire.from.node);

    expect(intoRounds).toEqual(['conversation']);
  });
  it.each(BUILT_IN_PROCEDURES.map((procedure) => [procedure.id, procedure] as const))('%s checks clean against the built-in nodes and groups', (_id, procedure) => {
    expect(checkProcedure(procedure, { catalogue, groups: BUILT_IN_GROUPS })).toEqual([]);
  });

  it.each(BUILT_IN_PROCEDURES.map((procedure) => [procedure.id, procedure] as const))('%s releases any sandbox it provisions, however it ends', (_id, procedure) => {
    const provisions = procedure.nodes.some((node) => node.kind === 'provision-sandbox');

    const kindsInCleanup = new Set<string>();
    const walk = (from: string | undefined, seen = new Set<string>()): void => {
      if (!from || seen.has(from)) return;
      seen.add(from);
      kindsInCleanup.add(procedure.nodes.find((node) => node.id === from)?.kind ?? '');
      for (const edge of procedure.flow.filter((entry) => entry.from === from)) walk(edge.to, seen);
    };
    walk(procedure.cleanup);

    expect(kindsInCleanup.has('release-sandbox')).toBe(provisions);
  });

  it('keep ids unique and match the procedures agents already point at', () => {
    expect(BUILT_IN_PROCEDURES.map((procedure) => procedure.id)).toEqual(['tool-rounds', 'interactive-chat', 'planning', 'research', 'single-shot', 'do-one-task', 'delivery', 'grove-judge-pass']);
  });

  it('expand into plain nodes a run can execute', () => {
    for (const procedure of BUILT_IN_PROCEDURES) {
      const { body } = expandGroups(procedure, groupLibrary(procedure, BUILT_IN_GROUPS));
      expect(body.nodes.every((node) => node.kind !== 'group'), procedure.id).toBe(true);
    }
  });
});

describe('the steps do-one-task carries out for the model', () => {
  it('claims the task and records the outcome itself, and says so', () => {
    const handled = handledTools(DO_ONE_TASK_V2);

    expect(Object.keys(handled).sort()).toEqual(['judge', 'mark_done', 'mark_failed', 'start_task']);
    expect(handled.start_task).toBe('The task has already been claimed for you.');
    expect(handled.mark_done).toContain('Do not record it yourself.');
    expect(handled.judge).toContain('You do not have to ask it yourself.');
  });

  it('leaves run_command alone, because the model still needs it', () => {
    expect(handledTools(DO_ONE_TASK_V2).run_command).toBeUndefined();
  });

  it('tells the model what happens around it', () => {
    const text = describeHandledSteps(DO_ONE_TASK_V2);

    expect(text).toContain('WHAT THE PROCEDURE DOES AROUND YOU');
    expect(text).toContain('- The task has already been claimed for you.');
  });
});

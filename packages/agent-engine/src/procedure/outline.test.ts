import { describe, it, expect } from 'vitest';
import { agentsHandedTo, callsModel, describeOutline, outlineProcedure } from './outline.js';
import type { PlacedNode, Procedure } from './schema.js';

const node = (id: string, kind: string, settings: Record<string, unknown> = {}): PlacedNode =>
  ({ id, kind, settings, position: [0, 0] }) as unknown as PlacedNode;

const proc = (id: string, describe: string, nodes: PlacedNode[], groups: unknown[] = []) =>
  ({ id, name: id, describe, nodes, groups }) as unknown as Procedure;

const grow = proc('grow', 'Grows the tree until quiet.', [
  node('open', 'host-op'),
  node('work', 'fan-out', { agent: 'worker' }),
  node('judge', 'fan-out', { agent: 'judge' }),
  node('again', 'fan-out', { agent: 'worker' }),
], [{ id: 'g', nodes: [node('plan', 'delegate', { agent: 'planner' })] }]);

const procedures: Record<string, Procedure> = {
  worker: proc('work-leaf', 'Works one leaf task by task.', []),
  judge: proc('tool-rounds', 'Calls tools round after round.', []),
  planner: proc('planning', 'Plans what is not planned yet.', [node('back', 'delegate', { agent: 'grower' })]),
  grower: grow,
};
const agents: Record<string, string> = { worker: 'Works a leaf', judge: 'Settles a claim from its commit', planner: 'Breaks a goal into checkable work' };
const agentOf = (agent: string) => (agents[agent] || procedures[agent] ? { describe: agents[agent], procedure: procedures[agent] } : undefined);

describe('a procedure describing itself', () => {
  it('names each agent it hands work to once, in order, including inside its groups', () => {
    expect(agentsHandedTo(grow)).toEqual(['worker', 'judge', 'planner']);
  });

  it('says whether it asks a model anything, inside its groups too', () => {
    expect(callsModel(grow)).toBe(false);
    expect(callsModel(proc('chat', '', [node('m', 'call-model')]))).toBe(true);
    expect(callsModel(proc('rounds', '', [], [{ id: 'r', nodes: [node('pick', 'choose-model')] }]))).toBe(true);
  });

  it('outlines itself from its own words and the words of the procedures it hands work to', () => {
    const outline = outlineProcedure(grow, agentOf);
    expect(describeOutline(outline)).toBe([
      'grow: Grows the tree until quiet.',
      '  worker: Works a leaf',
      '    runs work-leaf: Works one leaf task by task.',
      '  judge: Settles a claim from its commit',
      '    runs tool-rounds: Calls tools round after round.',
      '  planner: Breaks a goal into checkable work',
      '    runs planning: Plans what is not planned yet.',
      '      grower: an agent it hands work to',
    ].join('\n'));
  });

  it('stops at the depth it is given and never loops back into itself', () => {
    const deep = outlineProcedure(grow, agentOf, 3);
    const planner = deep.handsTo.find((hand) => hand.agent === 'planner')!.procedure!;
    expect(planner.handsTo).toEqual([{ agent: 'grower' }]);
    expect(outlineProcedure(grow, agentOf, 0).handsTo).toEqual([{ agent: 'worker', describe: 'Works a leaf' }, { agent: 'judge', describe: 'Settles a claim from its commit' }, { agent: 'planner', describe: 'Breaks a goal into checkable work' }]);
  });

  it('says plainly when it cannot find the procedure an agent runs', () => {
    expect(describeOutline(outlineProcedure(grow, () => undefined))).toContain('  worker: an agent it hands work to');
  });
});

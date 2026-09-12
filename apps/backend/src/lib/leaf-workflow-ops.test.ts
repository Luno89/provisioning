import { describe, it, expect } from 'vitest';
import type { WorkflowStageNode } from './leaf-workflow-types.js';
import {
  findWorkflowNode, insertWorkflowNode, removeWorkflowNode, clearWorkflowStageReferences,
} from './leaf-workflow-ops.js';

const stage = (id: string, extra: Partial<WorkflowStageNode> = {}): WorkflowStageNode => (
  { id, name: id, stage: 'land', ...extra } as WorkflowStageNode
);

const group = (id: string, children: WorkflowStageNode[]): WorkflowStageNode => (
  { id, name: id, containerType: 'group', children }
);

describe('leaf-workflow-ops tree editing', () => {
  it('finds and inserts nodes', () => {
    const tree = insertWorkflowNode([stage('a')], null, 1, stage('b'));
    expect(tree.map((n) => n.id)).toEqual(['a', 'b']);
    expect(findWorkflowNode(tree, 'b')?.id).toBe('b');
  });

  it('removes a nested node', () => {
    const tree = [group('g', [stage('a'), stage('b')])];
    const { nodes, removed } = removeWorkflowNode(tree, 'a');
    expect(removed?.id).toBe('a');
    const g = nodes[0] as Extract<WorkflowStageNode, { containerType: 'group' }>;
    expect(g.children.map((c) => c.id)).toEqual(['b']);
  });
});

describe('clearWorkflowStageReferences', () => {
  it('clears a plain string runIf pointing at the removed id', () => {
    const tree = [stage('a', { runIf: 'removed' })];
    expect(clearWorkflowStageReferences(tree, 'removed')[0]!.runIf).toBeUndefined();
  });

  it('clears a ranOk/threw condition referencing the removed id', () => {
    const tree = [stage('a', { runIf: { op: 'ranOk', ref: 'removed' } })];
    expect(clearWorkflowStageReferences(tree, 'removed')[0]!.runIf).toBeUndefined();
  });

  it('clears a path-based condition referencing the removed id\'s output', () => {
    const tree = [stage('a', { runIf: { op: 'gt', path: 'stages.removed.output.stuck.length', value: 0 } })];
    expect(clearWorkflowStageReferences(tree, 'removed')[0]!.runIf).toBeUndefined();
  });

  it('clears a reference nested inside and/or/not', () => {
    const tree = [stage('a', {
      runIf: { op: 'and', conditions: [{ op: 'ranOk', ref: 'keep' }, { op: 'not', condition: { op: 'ranOk', ref: 'removed' } }] },
    })];
    expect(clearWorkflowStageReferences(tree, 'removed')[0]!.runIf).toBeUndefined();
  });

  it('leaves an unrelated condition untouched', () => {
    const tree = [stage('a', { runIf: { op: 'ranOk', ref: 'keep' } })];
    expect(clearWorkflowStageReferences(tree, 'removed')[0]!.runIf).toEqual({ op: 'ranOk', ref: 'keep' });
  });

  it('clears references nested inside a group', () => {
    const tree = [group('g', [stage('a', { runIf: 'removed' })])];
    const next = clearWorkflowStageReferences(tree, 'removed');
    const g = next[0] as Extract<WorkflowStageNode, { containerType: 'group' }>;
    expect(g.children[0]!.runIf).toBeUndefined();
  });
});

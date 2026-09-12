import { describe, it, expect } from 'vitest';
import {
  validateWorkflowStageNodes, validateLeafWorkflowSpec, evalCondition, getPath, normalizeRunIf,
  DEFAULT_LEAF_WORKFLOW, type WorkflowEvalContext, type WorkflowStageNode,
} from './leaf-workflow-types.js';

describe('validateWorkflowStageNodes', () => {
  it('accepts a simple stage list', () => {
    const err = validateWorkflowStageNodes(
      [{ id: 'a', name: 'Judge', stage: 'judge' }],
      new Set<string>(),
    );
    expect(err).toBeNull();
  });

  it('refuses an unknown stage type', () => {
    const err = validateWorkflowStageNodes(
      [{ id: 'a', name: 'X', stage: 'bogus' }],
      new Set<string>(),
    );
    expect(err).toMatch(/stage must be one of/i);
  });

  it('accepts a group and a loop containing stages', () => {
    const err = validateWorkflowStageNodes(
      [
        { id: 'g', name: 'Group', containerType: 'group', children: [{ id: 'a', name: 'Judge', stage: 'judge' }] },
        { id: 'l', name: 'Loop', containerType: 'loop', loopType: 'count', maxIterations: 2, children: [{ id: 'b', name: 'Land', stage: 'land' }] },
      ],
      new Set<string>(),
    );
    expect(err).toBeNull();
  });

  it('requires maxIterations for count/until loops', () => {
    const err = validateWorkflowStageNodes(
      [{ id: 'l', name: 'Loop', containerType: 'loop', loopType: 'until', children: [] }],
      new Set<string>(),
    );
    expect(err).toMatch(/maxIterations/i);
  });

  it('requires itemsFrom for forEach loops', () => {
    const err = validateWorkflowStageNodes(
      [{ id: 'l', name: 'Loop', containerType: 'loop', loopType: 'forEach', children: [] }],
      new Set<string>(),
    );
    expect(err).toMatch(/itemsFrom/i);
  });

  it('accepts a string-sugar runIf referencing an earlier stage', () => {
    const err = validateWorkflowStageNodes(
      [
        { id: 'a', name: 'Land', stage: 'land' },
        { id: 'b', name: 'Resolve', stage: 'resolve', runIf: 'a' },
      ],
      new Set<string>(),
    );
    expect(err).toBeNull();
  });

  it('refuses a string-sugar runIf naming a later stage', () => {
    const err = validateWorkflowStageNodes(
      [
        { id: 'a', name: 'Resolve', stage: 'resolve', runIf: 'b' },
        { id: 'b', name: 'Land', stage: 'land' },
      ],
      new Set<string>(),
    );
    expect(err).toMatch(/earlier stage/i);
  });

  it('accepts a condition-object runIf referencing an earlier stage and a treeType path', () => {
    const err = validateWorkflowStageNodes(
      [
        { id: 'land', name: 'Land', stage: 'land' },
        {
          id: 'resolve', name: 'Resolve', stage: 'resolve',
          runIf: { op: 'and', conditions: [
            { op: 'ranOk', ref: 'land' },
            { op: 'gt', path: 'stages.land.output.stuck.length', value: 0 },
            { op: 'eq', path: 'treeType.autoAccept.enabled', value: true },
          ] },
        },
      ],
      new Set<string>(),
    );
    expect(err).toBeNull();
  });

  it('refuses a condition referencing a stage that has not appeared yet', () => {
    const err = validateWorkflowStageNodes(
      [{ id: 'a', name: 'Land', stage: 'land', runIf: { op: 'gt', path: 'stages.ghost.output.x', value: 1 } }],
      new Set<string>(),
    );
    expect(err).toMatch(/earlier stage/i);
  });

  it('refuses a condition path with an unknown root', () => {
    const err = validateWorkflowStageNodes(
      [{ id: 'a', name: 'Land', stage: 'land', runIf: { op: 'eq', path: 'nonsense.field', value: 1 } }],
      new Set<string>(),
    );
    expect(err).toMatch(/leaf\.|treeType\.|stages\./);
  });

  it('a child can runIf its own parent group', () => {
    const err = validateWorkflowStageNodes(
      [
        {
          id: 'g', name: 'Group', containerType: 'group', runIf: undefined,
          children: [{ id: 'a', name: 'Land', stage: 'land', runIf: 'g' }],
        },
      ],
      new Set<string>(),
    );
    expect(err).toBeNull();
  });
});

describe('validateLeafWorkflowSpec', () => {
  it('validates both onSuccess and onFailure independently', () => {
    expect(validateLeafWorkflowSpec({ onSuccess: [], onFailure: [] })).toBeNull();
    expect(validateLeafWorkflowSpec({ onSuccess: [{ id: 'a', name: 'X', stage: 'bogus' }], onFailure: [] }))
      .toMatch(/stage must be one of/i);
  });

  it('accepts the shipped default', () => {
    expect(validateLeafWorkflowSpec(DEFAULT_LEAF_WORKFLOW)).toBeNull();
  });
});

describe('getPath / evalCondition', () => {
  const ctx: WorkflowEvalContext = {
    leaf: { status: 'succeeded' },
    treeType: { autoAccept: { enabled: true } },
    stages: {
      land: { ranOk: true, output: { stuck: ['a', 'b'] } },
      judge: { ranOk: false, output: undefined },
    },
  };

  it('resolves leaf/treeType/stages paths', () => {
    expect(getPath(ctx.leaf, 'status')).toBe('succeeded');
    expect(evalCondition({ op: 'eq', path: 'leaf.status', value: 'succeeded' }, ctx)).toBe(true);
    expect(evalCondition({ op: 'eq', path: 'treeType.autoAccept.enabled', value: true }, ctx)).toBe(true);
    expect(evalCondition({ op: 'gt', path: 'stages.land.output.stuck.length', value: 0 }, ctx)).toBe(true);
    expect(evalCondition({ op: 'gt', path: 'stages.land.output.stuck.length', value: 5 }, ctx)).toBe(false);
  });

  it('ranOk / threw read a stage\'s recorded outcome', () => {
    expect(evalCondition({ op: 'ranOk', ref: 'land' }, ctx)).toBe(true);
    expect(evalCondition({ op: 'threw', ref: 'judge' }, ctx)).toBe(true);
    expect(evalCondition({ op: 'ranOk', ref: 'judge' }, ctx)).toBe(false);
    expect(evalCondition({ op: 'ranOk', ref: 'never-ran' }, ctx)).toBe(false);
  });

  it('exists / notExists / and / or / not compose correctly', () => {
    expect(evalCondition({ op: 'exists', path: 'stages.land.output.stuck' }, ctx)).toBe(true);
    expect(evalCondition({ op: 'notExists', path: 'stages.ghost.output' }, ctx)).toBe(true);
    expect(evalCondition({ op: 'and', conditions: [{ op: 'ranOk', ref: 'land' }, { op: 'ranOk', ref: 'judge' }] }, ctx)).toBe(false);
    expect(evalCondition({ op: 'or', conditions: [{ op: 'ranOk', ref: 'land' }, { op: 'ranOk', ref: 'judge' }] }, ctx)).toBe(true);
    expect(evalCondition({ op: 'not', condition: { op: 'ranOk', ref: 'judge' } }, ctx)).toBe(true);
  });

  it('normalizeRunIf turns string sugar into a ranOk condition', () => {
    expect(normalizeRunIf('land')).toEqual({ op: 'ranOk', ref: 'land' });
    const cond: WorkflowStageNode['runIf'] = { op: 'threw', ref: 'judge' };
    expect(normalizeRunIf(cond!)).toEqual(cond);
  });
});

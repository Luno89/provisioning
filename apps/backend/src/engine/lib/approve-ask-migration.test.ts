import { describe, it, expect } from 'vitest';
import { dropApproveAskSetting } from './approve-ask-migration.js';
import type { ProcedureSource } from './procedure-source.js';

const approve = (settings: Record<string, unknown>) => ({ id: 'approve', kind: 'approve-tool-calls', settings, position: { x: 0, y: 0 } });

const stored = (body: Record<string, unknown>, ownerId = 'u1'): ProcedureSource => ({
  id: 'mine', ownerId, version: '3', updatedAt: 'then',
  source: JSON.stringify({ schema: 2, id: 'mine', start: 'approve', nodes: [], wires: [], flow: [], groups: [], ...body }, null, 2),
});

const storeOf = (rows: ProcedureSource[]) => {
  const saved: ProcedureSource[] = [];
  return { saved, store: { getProcedures: async () => rows, saveProcedure: async (row: ProcedureSource) => { saved.push(row); } } };
};

describe('dropping the approve node\'s old ask setting from saved procedures', () => {
  it('takes ask off every approve node, in the procedure and in its groups, and leaves everything else as it was', async () => {
    const row = stored({
      nodes: [approve({ ask: 'never' }), { id: 'other', kind: 'call-tool', settings: { tool: 'x', ask: 'kept' }, position: { x: 1, y: 2 } }],
      groups: [{ id: 'turn', nodes: [approve({ ask: 'always' })], wires: [], flow: [], inputs: [], outputs: [], exits: [] }],
    });
    const { saved, store } = storeOf([row]);

    expect(await dropApproveAskSetting(store, 'now')).toEqual({ procedures: 1 });

    const written = JSON.parse(saved[0]!.source) as { nodes: { settings: Record<string, unknown> }[]; groups: { nodes: { settings: Record<string, unknown> }[] }[] };
    expect(written.nodes[0]!.settings).toEqual({});
    expect(written.nodes[1]!.settings).toEqual({ tool: 'x', ask: 'kept' });
    expect(written.groups[0]!.nodes[0]!.settings).toEqual({});
    expect(saved[0]).toMatchObject({ id: 'mine', ownerId: 'u1', version: '3', updatedAt: 'now' });
  });

  it('saves nothing for a procedure with no ask setting, or one that does not read', async () => {
    const { saved, store } = storeOf([stored({ nodes: [approve({})] }), { id: 'broken', ownerId: 'u1', version: '1', updatedAt: 'then', source: '{not json' }]);

    expect(await dropApproveAskSetting(store, 'now')).toEqual({ procedures: 0 });
    expect(saved).toEqual([]);
  });
});

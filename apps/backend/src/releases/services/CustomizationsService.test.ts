import { describe, it, expect } from 'vitest';
import { CustomizationsService } from './CustomizationsService.js';
import type { SlotAdapter } from '../../extensions/releases/adapter.js';
import type { SlotCluster } from '../../extensions/releases/slot-cluster.js';
import type { PlanProposal } from '../../projects/lib/plan-proposals.js';
import type { InventoryItem } from '../lib/release-compare.js';

const items: InventoryItem[] = [
  { kind: 'field', key: 'koala.probe.x_note', name: 'The field Note (x_note) on koala.probe, made in the app,', fingerprint: 'f', active: true },
  { kind: 'edited-view', key: 'id:186', name: 'The view koala.probe.form, edited in the app,', fingerprint: 'g', active: true },
];

function setUp(over: { live?: boolean; noTree?: boolean; branches?: { id: string; treeId: string; title: string; ownerId: string; createdAt: string; updatedAt: string }[] } = {}) {
  const saved: PlanProposal[] = [];
  const exported: unknown[] = [];
  const adapter = {
    id: 'odoo',
    inventory: async () => items,
    customizationsModule: () => 'shop_customizations',
    exportItems: async (_c: unknown, _t: unknown, slot: string, wanted: unknown) => { exported.push([slot, wanted]); return { module: 'shop_customizations', files: [{ path: 'addons/shop_customizations/__init__.py', content: '' }], refused: [] }; },
  } as unknown as SlotAdapter;
  const cluster = { state: async () => (over.live === false ? { installed: false, live: 'a', tags: { a: undefined, b: undefined } } : { installed: true, live: 'b', tags: { a: 'one', b: 'two' } }) } as unknown as SlotCluster;
  const service = new CustomizationsService({
    projects: async () => [{ id: 'p1', name: 'Shop', ownerId: 'u1', targetClusterId: 'c1', appType: 'gitapp', createdAt: 'x' } as never, { id: 'p2', name: 'Other', ownerId: 'u2', targetClusterId: 'c1' } as never],
    clusterById: async () => ({ id: 'c1', name: 'system', provider: 'k3d' }) as never,
    how: async () => ({ agent: 'release', app: 'odoo' }),
    cluster,
    adapters: { odoo: adapter },
    trees: async () => (over.noTree ? [] : [{ id: 't1', ownerId: 'u1', name: 'Shop', type: 'odoo-addons', projectIds: ['p1'], createdAt: 'x', updatedAt: 'x' }]),
    branches: async () => over.branches ?? [],
    leaves: async () => [],
    tasks: async () => [],
    savePlan: async (proposal) => { saved.push(proposal); },
    treeTypeOf: async () => 'odoo-addons',
    now: () => 'now',
    newId: () => 'card-1',
  });
  return { service, saved, exported };
}

describe('what was made in a project\'s live app', () => {
  it('lists it from the live slot, and nothing while nothing is live', async () => {
    expect(await setUp().service.drift('u1', 'p1')).toEqual({ ok: true, value: { projectId: 'p1', project: 'Shop', module: 'shop_customizations', items } });
    expect(await setUp({ live: false }).service.drift('u1', 'p1')).toMatchObject({ ok: true, value: { items: [] } });
    expect(await setUp().service.drift('u1', 'p2')).toEqual({ ok: false, status: 404, error: 'You have no project with that id' });
  });

  it('proposes one story bringing it into git, in a feature made when the card is approved', async () => {
    const { service, saved } = setUp();
    const proposed = await service.propose('u1', 'p1', { why: 'keep what the client made' }, { conversationId: 'channel-p1' });
    expect(proposed.ok).toBe(true);
    expect(saved).toHaveLength(1);
    const card = saved[0]!;
    expect(card).toMatchObject({ id: 'card-1', ownerId: 'u1', projectId: 'p1', status: 'proposed', conversationId: 'channel-p1' });
    expect(card.change?.add).toMatchObject({ branchId: 't1-customizations', branchTitle: 'Customizations from the live app', newBranch: true });
    const story = card.change!.add!.leaves[0]!;
    expect(story.title).toBe('Bring 2 customizations made in the app into git');
    expect(story.tasks[0]!.description).toContain('export_customizations with refs ["field/koala.probe.x_note","edited-view/id:186"]');
    expect(story.tasks[0]!.doneMeans).toBe('addons/shop_customizations holds the exported files unchanged and odoo-check passes on it');
  });

  it('adds to the feature the tree already has, brings in only the items named, and refuses ones it does not hold', async () => {
    const { service, saved } = setUp({ branches: [{ id: 'b9', treeId: 't1', title: 'Customizations from the live app', ownerId: 'u1', createdAt: 'x', updatedAt: 'x' }] });
    await service.propose('u1', 'p1', { why: 'w', refs: ['edited-view/id:186'] }, {});
    expect(saved[0]!.change?.add).toMatchObject({ branchId: 'b9' });
    expect(saved[0]!.change?.add?.newBranch).toBeUndefined();
    expect(saved[0]!.change!.add!.leaves[0]!.title).toBe('Bring 1 customization made in the app into git');
    expect(await service.propose('u1', 'p1', { why: 'w', refs: ['view/id:1'] }, {})).toEqual({ ok: false, status: 400, error: 'view/id:1 is not among what the live app holds outside git' });
    expect(await service.propose('u1', 'p1', {}, {})).toEqual({ ok: false, status: 400, error: 'say why, for the card' });
  });

  it('exports the named refs from the live slot, and refuses refs it cannot read', async () => {
    const { service, exported } = setUp();
    expect(await service.exportItems('u1', 'p1', ['field/koala.probe.x_note'])).toMatchObject({ ok: true, value: { module: 'shop_customizations' } });
    expect(exported).toEqual([['b', [{ kind: 'field', key: 'koala.probe.x_note' }]]]);
    expect(await service.exportItems('u1', 'p1', ['nonsense'])).toEqual({ ok: false, status: 400, error: 'nonsense is not a ref; app_drift lists them' });
  });

  it('proposes a tree for the project holding the story when the project has none', async () => {
    const { service, saved } = setUp({ noTree: true });
    expect((await service.propose('u1', 'p1', { why: 'keep it' }, {})).ok).toBe(true);
    const plan = saved[0]!.plan!;
    expect(saved[0]).toMatchObject({ projectId: 'p1', status: 'proposed' });
    expect(plan.tree).toMatchObject({ name: 'Shop', type: 'odoo-addons' });
    expect(plan.branches.map((branch) => [branch.title, branch.leaves.map((leaf) => leaf.title)])).toEqual([['Customizations from the live app', ['Bring 2 customizations made in the app into git']]]);
    expect(plan.planDoc).toContain('## Destination');
  });
});

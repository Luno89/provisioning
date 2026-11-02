import { describe, expect, it } from 'vitest';
import { CustomizationsService } from '../services/CustomizationsService.js';
import type { SlotAdapter } from '../../extensions/releases/adapter.js';
import type { SlotCluster } from '../../extensions/releases/slot-cluster.js';
import type { Database } from '../../platform/lib/db-interface.js';
import type { InventoryItem } from '../lib/release-compare.js';

export const customizationItems: InventoryItem[] = [
  { kind: 'field', key: 'koala.probe.x_note', name: 'The field Note (x_note) on koala.probe, made in the app,', fingerprint: 'f', active: true },
  { kind: 'edited-view', key: 'id:186', name: 'The view koala.probe.form, edited in the app,', fingerprint: 'g', active: true },
];

export interface CustomizationsWorld {
  owner?: string;
  live?: boolean;
  noTree?: boolean;
  branches?: { id: string; treeId: string; title: string; ownerId: string; createdAt: string; updatedAt: string }[];
}

export async function customizationsOver(db: Database, over: CustomizationsWorld = {}) {
  const owner = over.owner ?? 'u1';
  const exported: unknown[] = [];
  const adapter = {
    id: 'odoo',
    inventory: async () => customizationItems,
    customizationsModule: () => 'shop_customizations',
    exportItems: async (_c: unknown, _t: unknown, slot: string, wanted: unknown) => { exported.push([slot, wanted]); return { module: 'shop_customizations', files: [{ path: 'addons/shop_customizations/__init__.py', content: '' }], refused: [] }; },
  } as unknown as SlotAdapter;
  const cluster = { state: async () => (over.live === false ? { installed: false, live: 'a', tags: { a: undefined, b: undefined } } : { installed: true, live: 'b', tags: { a: 'one', b: 'two' } }) } as unknown as SlotCluster;
  await db.projects.saveProject({ id: 'p1', name: 'Shop', ownerId: owner, targetClusterId: 'c1', giteaOwner: owner, giteaRepo: 'shop', appType: 'gitapp', createdAt: 'x' });
  await db.projects.saveProject({ id: 'p2', name: 'Other', ownerId: 'u2', targetClusterId: 'c1', giteaOwner: 'u2', giteaRepo: 'other', appType: 'gitapp', createdAt: 'x' });
  if (!over.noTree) await db.projects.saveTree({ id: 't1', ownerId: owner, name: 'Shop', type: 'odoo-addons', projectIds: ['p1'], createdAt: 'x', updatedAt: 'x' } as never);
  for (const branch of over.branches ?? []) await db.projects.saveBranch(branch as never);
  const service = new CustomizationsService({
    projects: () => db.projects.getProjects(),
    clusterById: async () => ({ id: 'c1', name: 'system', provider: 'k3d' }) as never,
    how: async () => ({ agent: 'release', app: 'odoo' }),
    cluster,
    adapters: { odoo: adapter },
    trees: () => db.projects.getTrees(),
    branches: () => db.projects.getBranches(),
    leaves: () => db.projects.getLeaves(),
    tasks: (ownerId) => db.projects.getTasks(ownerId),
    savePlan: (proposal) => db.projects.savePlanProposal(proposal),
    treeTypeOf: async () => 'odoo-addons',
    now: () => 'now',
    newId: () => 'card-1',
  });
  return { service, exported, saved: () => db.projects.getPlanProposals(owner) };
}

export function customizationsBehaviour(make: () => Promise<Database>): void {
  describe('what was made in a project\'s live app', () => {
    it('lists it from the live slot, and nothing while nothing is live', async () => {
      expect(await (await customizationsOver(await make())).service.drift('u1', 'p1')).toEqual({ ok: true, value: { projectId: 'p1', project: 'Shop', module: 'shop_customizations', items: customizationItems } });
      expect(await (await customizationsOver(await make(), { live: false })).service.drift('u1', 'p1')).toMatchObject({ ok: true, value: { items: [] } });
      expect(await (await customizationsOver(await make())).service.drift('u1', 'p2')).toEqual({ ok: false, status: 404, error: 'You have no project with that id' });
    });

    it('proposes one story bringing it into git, in a feature made when the card is approved', async () => {
      const { service, saved } = await customizationsOver(await make());
      const proposed = await service.propose('u1', 'p1', { why: 'keep what the client made' }, { conversationId: 'channel-p1' });
      expect(proposed.ok).toBe(true);
      const cards = await saved();
      expect(cards).toHaveLength(1);
      const card = cards[0]!;
      expect(card).toMatchObject({ id: 'card-1', ownerId: 'u1', projectId: 'p1', status: 'proposed', conversationId: 'channel-p1' });
      expect(card.change?.add).toMatchObject({ branchId: 't1-customizations', branchTitle: 'Customizations from the live app', newBranch: true });
      const story = card.change!.add!.leaves[0]!;
      expect(story.title).toBe('Bring 2 customizations made in the app into git');
      expect(story.tasks[0]!.description).toContain('export_customizations with refs ["field/koala.probe.x_note","edited-view/id:186"]');
      expect(story.tasks[0]!.doneMeans).toBe('addons/shop_customizations holds the exported files unchanged and odoo-check passes on it');
    });

    it('adds to the feature the tree already has, brings in only the items named, and refuses ones it does not hold', async () => {
      const { service, saved } = await customizationsOver(await make(), { branches: [{ id: 'b9', treeId: 't1', title: 'Customizations from the live app', ownerId: 'u1', createdAt: 'x', updatedAt: 'x' }] });
      await service.propose('u1', 'p1', { why: 'w', refs: ['edited-view/id:186'] }, {});
      const card = (await saved())[0]!;
      expect(card.change?.add).toMatchObject({ branchId: 'b9' });
      expect(card.change?.add?.newBranch).toBeUndefined();
      expect(card.change!.add!.leaves[0]!.title).toBe('Bring 1 customization made in the app into git');
      expect(await service.propose('u1', 'p1', { why: 'w', refs: ['view/id:1'] }, {})).toEqual({ ok: false, status: 400, error: 'view/id:1 is not among what the live app holds outside git' });
      expect(await service.propose('u1', 'p1', {}, {})).toEqual({ ok: false, status: 400, error: 'say why, for the card' });
    });

    it('exports the named refs from the live slot, and refuses refs it cannot read', async () => {
      const { service, exported } = await customizationsOver(await make());
      expect(await service.exportItems('u1', 'p1', ['field/koala.probe.x_note'])).toMatchObject({ ok: true, value: { module: 'shop_customizations' } });
      expect(exported).toEqual([['b', [{ kind: 'field', key: 'koala.probe.x_note' }]]]);
      expect(await service.exportItems('u1', 'p1', ['nonsense'])).toEqual({ ok: false, status: 400, error: 'nonsense is not a ref; app_drift lists them' });
    });

    it('proposes a tree for the project holding the story when the project has none', async () => {
      const { service, saved } = await customizationsOver(await make(), { noTree: true });
      expect((await service.propose('u1', 'p1', { why: 'keep it' }, {})).ok).toBe(true);
      const card = (await saved())[0]!;
      const plan = card.plan!;
      expect(card).toMatchObject({ projectId: 'p1', status: 'proposed' });
      expect(plan.tree).toMatchObject({ name: 'Shop', type: 'odoo-addons' });
      expect(plan.branches.map((branch) => [branch.title, branch.leaves.map((leaf) => leaf.title)])).toEqual([['Customizations from the live app', ['Bring 2 customizations made in the app into git']]]);
      expect(plan.planDoc).toContain('## Destination');
    });
  });
}

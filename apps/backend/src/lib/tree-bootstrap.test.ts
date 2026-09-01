import { describe, it, expect, vi } from 'vitest';
import { bootstrapAcceptedTree } from './tree-bootstrap.js';
import { MemoryDB } from './memory-db.js';
import { seedAll } from '../scripts/seed-all.js';
import type { ProposedTree } from './conversations.js';
import type { TreeTypeSpec } from './tree-types.js';

const proposal = (over: Partial<ProposedTree> = {}): ProposedTree => ({
  id: 'prop-1',
  name: 'Weather API',
  type: 'api-service',
  goal: 'Build an internal weather service',
  proposedAt: new Date().toISOString(),
  ...over,
});

const repos = () => ({
  register: vi.fn().mockResolvedValue({
    id: 'proj-1',
    name: 'weather-api',
    ownerId: 'user-1',
    giteaOwner: 'testuser',
    giteaRepo: 'weather-api',
    appType: 'gitapp',
    targetClusterId: 'provisioning-lunorica',
    autoDeployOnBuild: true,
    createdAt: new Date().toISOString(),
  }),
  ensureShippable: vi.fn().mockImplementation((p) => Promise.resolve({ project: p, problems: [] })),
});

const boot = async (db: MemoryDB, over: Partial<ProposedTree> = {}) => {
  const planProject = vi.fn().mockResolvedValue('plan-wf-1');
  const result = await bootstrapAcceptedTree({
    db,
    projectRepoService: repos() as any,
    temporalBridge: { planProject } as any,
    nodeIp: '10.0.0.100',
    port: 3001,
    jwtSecret: 'test-secret',
  }, { userId: 'user-1', proposal: proposal(over) });
  return { result, planProject };
};

describe('tree-bootstrap', () => {
  it('creates the tree and branch, and starts planning', async () => {
    const db = new MemoryDB();
    await seedAll(db as never);

    const { result, planProject } = await boot(db);

    expect(result.tree.name).toBe('Weather API');
    expect(result.tree.projectIds).toContain('proj-1');
    expect(result.branch.treeId).toBe(result.tree.id);
    expect(result.branch.title).toBe('Weather API');
    expect(planProject).toHaveBeenCalledWith(result.tree.id, result.branch.id);

    expect((await db.getTrees()).find((t) => t.id === result.tree.id)).toBeDefined();
    expect((await db.getBranches()).find((b) => b.id === result.branch.id)).toBeDefined();
  });

  /**
   * The bug this whole change exists for. Accepting used to create a leaf, assign it by matching
   * the persona named 'Framer', hand it the tree type's validationRecipe as its own acceptance
   * contract, and run it in a sandbox — which is what made the planner try to build the product.
   */
  it('executes nothing: no leaf, and so no validation contract to satisfy', async () => {
    const db = new MemoryDB();
    await seedAll(db as never);

    await boot(db);

    expect(await db.getLeaves()).toEqual([]);
  });

  it('carries what the conversation established into the branch the planner reads', async () => {
    const db = new MemoryDB();
    await seedAll(db as never);

    const { result } = await boot(db, {
      brief: 'The user asked for hourly forecasts, not daily.',
      context: 'A weather MCP server is already running in the cluster.',
      openQuestions: 'Historical data is explicitly out of scope.',
      conversationId: 'conv-9',
    });

    expect(result.tree.brief).toContain('hourly forecasts');
    expect(result.tree.conversationId).toBe('conv-9');

    const opening = result.branch.messages[0]!.content;
    expect(opening).toContain('hourly forecasts');
    expect(opening).toContain('already running in the cluster');
    expect(opening).toContain('out of scope');
  });

  it('takes its planner from the tree type, so renaming a persona changes nothing', async () => {
    const db = new MemoryDB();
    await seedAll(db as never);

    const type = (await db.getTreeTypes('user-1')).find((t: TreeTypeSpec) => t.id === 'api-service');
    expect(type?.packs?.planner).toBe('planner');

    // Rename every persona. Selection is by pack slug named on the tree type, so nothing breaks.
    for (const persona of await db.getPersonas()) {
      await db.savePersona({ ...persona, name: `${persona.name} (renamed)` });
    }

    const { planProject } = await boot(db);
    expect(planProject).toHaveBeenCalled();
  });
});

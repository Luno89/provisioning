import { describe, it, expect, vi } from 'vitest';
import { bootstrapAcceptedTree } from './tree-bootstrap.js';
import { MemoryDB } from './memory-db.js';
import type { ProposedTree } from './conversations.js';

describe('tree-bootstrap', () => {
  it('creates tree, branch, and leaf records when proposal is accepted', async () => {
    const db = new MemoryDB();

    const proposal: ProposedTree = {
      id: 'prop-1',
      name: 'Weather API',
      type: 'node-service',
      goal: 'Build an internal weather service',
      proposedAt: new Date().toISOString(),
    };

    const mockRegister = vi.fn().mockResolvedValue({
      id: 'proj-1',
      name: 'weather-api',
      ownerId: 'user-1',
      giteaOwner: 'testuser',
      giteaRepo: 'weather-api',
      appType: 'gitapp',
      targetClusterId: 'provisioning-lunorica',
      autoDeployOnBuild: true,
      createdAt: new Date().toISOString(),
    });

    const mockEnsureShippable = vi.fn().mockImplementation((p) => Promise.resolve({ project: p, problems: [] }));
    const mockStartLeaf = vi.fn().mockResolvedValue('leaf-wf-1');

    const result = await bootstrapAcceptedTree({
      db,
      projectRepoService: {
        register: mockRegister,
        ensureShippable: mockEnsureShippable,
      } as any,
      temporalBridge: {
        startLeaf: mockStartLeaf,
      } as any,
      nodeIp: '10.0.0.100',
      port: 3001,
      jwtSecret: 'test-secret',
    }, {
      userId: 'user-1',
      proposal,
    });

    expect(result.tree.name).toBe('Weather API');
    expect(result.tree.projectIds).toContain('proj-1');
    expect(result.branch.treeId).toBe(result.tree.id);
    expect(result.branch.title).toBe('Weather API');
    expect(result.leaf.branchId).toBe(result.branch.id);
    expect(result.leaf.projectId).toBe('proj-1');
    expect(result.leaf.status).toBe('pending');

    expect(mockRegister).toHaveBeenCalledWith('user-1', 'Weather API', expect.any(Object));
    expect(mockEnsureShippable).toHaveBeenCalled();
    expect(mockStartLeaf).toHaveBeenCalledWith(result.leaf);

    const savedTrees = await db.getTrees();
    expect(savedTrees.find((t) => t.id === result.tree.id)).toBeDefined();

    const savedBranches = await db.getBranches();
    expect(savedBranches.find((b) => b.id === result.branch.id)).toBeDefined();

    const savedLeaves = await db.getLeaves();
    expect(savedLeaves.find((l) => l.id === result.leaf.id)).toBeDefined();
  });
});

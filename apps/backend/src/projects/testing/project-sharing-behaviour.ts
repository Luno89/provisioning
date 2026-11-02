import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { Database } from '../../platform/lib/db-interface.js';
import { ProjectSharingService, type HubSharing, type ProjectGroups } from '../services/ProjectSharingService.js';

const now = '2026-10-21T00:00:00Z';
const ann = { id: 'ann', email: 'ann@example.com' };
const dataKey = 'k'.repeat(32) as never;

async function setUp(make: () => Promise<Database>) {
  const db = await make();
  const sharing = mock<HubSharing>();
  sharing.reachable.mockResolvedValue(true);
  sharing.share.mockImplementation(async (_owner, project) => ({ hubProjectId: `hub-${project.id}` }));
  const groups = mock<ProjectGroups>();
  groups.check.mockResolvedValue(null);
  groups.claim.mockResolvedValue(undefined);
  groups.release.mockResolvedValue(undefined);
  const notices: unknown[] = [];
  const service = new ProjectSharingService({
    store: db, sharing, sync: { once: vi.fn(async () => undefined) }, dataKey, groups, republish: vi.fn(async () => undefined), now: () => now,
    ownerRepo: async (project) => ({ url: `http://gitea/${project.giteaOwner}/${project.giteaRepo}.git` }),
    notify: async (_owner, scope, notice) => { notices.push([scope, notice]); },
  });
  await db.projects.saveProject({ id: 'p1', ownerId: 'ann', name: 'Shop', giteaOwner: 'koala-ann', giteaRepo: 'shop', createdAt: now } as never);
  await db.projects.saveProject({ id: 'p2', ownerId: 'ann', name: 'Mine', createdAt: now } as never);
  await db.projects.saveTree({ id: 't1', ownerId: 'ann', name: 'Shop', type: 'odoo' as never, projectIds: ['p1'], createdAt: now, updatedAt: now });
  await db.projects.saveTree({ id: 't2', ownerId: 'ann', name: 'Mine', type: 'odoo' as never, projectIds: ['p2'], createdAt: now, updatedAt: now });
  return { db, sharing, notices, service };
}

export function sharedProjectRecordsBehaviour(make: () => Promise<Database>): void {
  describe('whether a project is shared', () => {
    it('is read from the links the database holds', async () => {
      const { service } = await setUp(make);
      await service.share(ann, 'p1', 'acme');
      expect(await service.shared('p1')).toBe(true);
      expect(await service.shared('p2')).toBe(false);
    });
  });

  describe('the two ends of a shared project\'s repository', () => {
    it('are the owner\'s repository and the hub\'s, opened with the sealed token', async () => {
      const { db, sharing, service } = await setUp(make);
      sharing.share.mockResolvedValue({ hubProjectId: 'hub-1', repo: { url: 'http://hub/shared-1/project.git', username: 'bot', token: 'tok-secret' } });
      await service.share(ann, 'p1', 'acme');
      const link = (await db.hub.getHubLinks())[0]!;
      expect(link.repo?.tokenEnc).not.toContain('tok-secret');
      expect(await service.repoSides().ends(link)).toEqual({
        owner: { url: 'http://gitea/koala-ann/shop.git' },
        hub: { url: 'http://hub/shared-1/project.git', auth: { username: 'bot', token: 'tok-secret' } },
      });
    });

    it('are none when the link has no repository or the project has none', async () => {
      const { db, service } = await setUp(make);
      expect(await service.repoSides().ends({ projectId: 'p1', ownerId: 'ann', hubProjectId: 'h', pulledThrough: 0, sharedAt: now })).toBeUndefined();
      await db.projects.deleteTree('t2');
      expect(await service.repoSides().ends({ projectId: 'p2', ownerId: 'ann', hubProjectId: 'h', pulledThrough: 0, sharedAt: now, repo: { url: 'u', username: 'b', tokenEnc: 'x' } })).toBeUndefined();
    });

    it('tell the project\'s channel when main conflicted, naming its tree', async () => {
      const { notices, service } = await setUp(make);
      await service.repoSides().conflicted({ projectId: 'p1', ownerId: 'ann', hubProjectId: 'h', pulledThrough: 0, sharedAt: now }, { files: ['a.txt'], kept: 'hub/main-1' });
      expect(notices).toEqual([[{ projectId: 'p1', treeId: 't1' }, expect.objectContaining({ kind: 'hub-main-conflict' })]]);
    });

    it('tell nobody about a project that is gone', async () => {
      const { notices, service } = await setUp(make);
      await service.repoSides().conflicted({ projectId: 'gone', ownerId: 'ann', hubProjectId: 'h', pulledThrough: 0, sharedAt: now }, { files: [], kept: 'x' });
      expect(notices).toEqual([]);
    });
  });
}

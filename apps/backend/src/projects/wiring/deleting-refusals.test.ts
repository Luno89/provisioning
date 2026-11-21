import express, { Router } from 'express';
import { describe, expect, it } from 'vitest';
import { workFor } from '@koala/engine-core/work-for';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { routesInProcess } from '../../platform/testing/routes.js';
import { TEST_USER } from '../../platform/routes/test-harness.js';
import { refuseWebhookOfDeletingProjects, refuseWorkOfDeletingProjects } from './deleting-refusals.js';

const at = '2026-11-21T00:00:00Z';
const me = TEST_USER.id;

async function world() {
  const db = memoryDatabase();
  for (const id of ['going', 'open']) await db.projects.saveProject({ id, name: id, ownerId: me, appType: 'gitapp', createdAt: at });
  await db.projects.saveProject({ id: 'kept', name: 'kept', ownerId: me, appType: 'gitapp', createdAt: at });
  await db.projects.markDeleting('kept', { startedAt: at, requestedBy: me, mode: 'archive' });
  await db.projects.archive('kept');
  await db.projects.markDeleting('going', { startedAt: at, requestedBy: me, mode: 'permanent' });
  await db.projects.saveTree({ id: 't-going', ownerId: me, name: 't', type: 'odoo-addons', projectIds: ['going'], createdAt: at, updatedAt: at });
  await db.projects.saveTree({ id: 't-open', ownerId: me, name: 't', type: 'odoo-addons', projectIds: ['open'], createdAt: at, updatedAt: at });
  await db.projects.saveBranch({ id: 'b-going', ownerId: me, treeId: 't-going', title: 'b', createdAt: at, updatedAt: at });
  await db.projects.saveLeaf({ id: 'l-going', ownerId: me, branchId: 'b-going', title: 'l', status: 'pending', createdAt: at, updatedAt: at });
  await db.projects.saveTask({ id: 'k-going', ownerId: me, projectId: 'going', title: 'k', status: 'proposed', createdAt: at } as never);
  await db.projects.savePlanProposal({ id: 'pp-going', ownerId: me, plan: { treeId: 't-going', branches: [] }, status: 'proposed', createdAt: at } as never);
  await db.projects.saveSecretRequest({ id: 's-going', ownerId: me, projectId: 'going', key: 'API_KEY', createdAt: at } as never);
  await db.engine.saveConversation({ id: 'c-going', ownerId: me, title: 'c', projectId: 'going', messages: [], createdAt: at, updatedAt: at });
  await db.engine.saveConversation({ id: 'c-tree', ownerId: me, title: 'c', treeId: 't-going', messages: [], createdAt: at, updatedAt: at });
  await db.engine.saveConversation({ id: 'c-open', ownerId: me, title: 'c', projectId: 'open', messages: [], createdAt: at, updatedAt: at });
  await db.engine.saveMcpRequest({ id: 'm-going', ownerId: me, conversationId: 'c-going', createdAt: at } as never);
  await db.engine.saveActionProposal({ id: 'a-going', ownerId: me, conversationId: 'c-tree', createdAt: at } as never);
  await db.engine.saveRunGrant({ id: 'g-going', runId: 'r-going', personId: me, ownerId: me, scope: { projectId: 'going' }, createdAt: at } as never);
  await db.infrastructure.saveEgressRequest({ id: 'e-going', ownerId: me, treeId: 't-going', createdAt: at } as never);
  await db.infrastructure.saveAccessRequest({ id: 'x-going', ownerId: me, conversationId: 'c-going', createdAt: at } as never);
  await db.infrastructure.saveDeployment({ id: 'd-going', ownerId: me, name: 'shop', appType: 'gitapp', gitappProjectId: 'going', createdAt: at } as never);
  await db.infrastructure.saveDeployment({ id: 'd-named', ownerId: me, name: 'going', appType: 'gitapp', createdAt: at } as never);
  await db.infrastructure.savePendingApproval({ id: 'pa-going', ownerId: me, projectId: 'going', createdAt: at } as never);

  const router = Router();
  router.use(express.json());
  refuseWebhookOfDeletingProjects(router, db);
  refuseWorkOfDeletingProjects(router, db);
  router.use((_req, res) => { res.json({ reached: workFor()?.project ?? null }); });
  return routesInProcess({ prefix: '/', router: () => router, db });
}

const REFUSED: [string, string, unknown?][] = [
  ['PATCH', '/api/projects/going'],
  ['POST', '/api/projects/going/runs/run-1/promote'],
  ['POST', '/api/projects/going/releases/r1/again'],
  ['PUT', '/api/projects/going/files/content'],
  ['DELETE', '/api/projects/going/files/content'],
  ['PUT', '/api/trees/t-going/models'],
  ['POST', '/api/trees/t-going/run'],
  ['PUT', '/api/branches/b-going/order'],
  ['POST', '/api/leaves/l-going/retry'],
  ['POST', '/api/plans/pp-going/approve'],
  ['POST', '/api/items/leaf/l-going/chat'],
  ['POST', '/api/items/branch/b-going/chat'],
  ['POST', '/api/secret-requests/s-going/submit'],
  ['POST', '/api/conversations', { projectId: 'going' }],
  ['POST', '/api/conversations', { treeId: 't-going' }],
  ['POST', '/api/conversations/c-going/messages'],
  ['PATCH', '/api/conversations/c-tree'],
  ['POST', '/api/engine/runs', { conversationId: 'c-tree' }],
  ['POST', '/api/engine/runs', { inputs: { leafId: 'l-going' } }],
  ['POST', '/api/engine/runs/r-going/answer'],
  ['POST', '/api/engine/runs/r-going/approve'],
  ['POST', '/api/engine/tasks/k-going/accept'],
  ['PUT', '/api/auto-mode/trees/t-going'],
  ['PUT', '/api/auto-mode/conversations/c-going'],
  ['PUT', '/api/mcp/conversations/c-going/servers'],
  ['POST', '/api/mcp/requests/m-going/enable'],
  ['POST', '/api/actions/a-going/apply'],
  ['POST', '/api/egress/requests/e-going/allow'],
  ['POST', '/api/cluster-access/x-going/grant'],
  ['POST', '/api/files/projects/going/drop'],
  ['PUT', '/api/files/conversations/c-tree/content'],
  ['POST', '/api/deployments/d-going/expose'],
  ['PATCH', '/api/deployments/d-named/config'],
  ['POST', '/api/pending-approvals/pa-going/decide'],
  ['PUT', '/api/release-settings/projects/going'],
];

const LET_THROUGH: [string, string][] = [
  ['DELETE', '/api/projects/going'],
  ['POST', '/api/trees/t-going/run/stop'],
  ['DELETE', '/api/trees/t-going/workspace'],
  ['DELETE', '/api/trees/t-going'],
  ['DELETE', '/api/branches/b-going'],
  ['POST', '/api/leaves/l-going/cancel'],
  ['DELETE', '/api/leaves/l-going'],
  ['POST', '/api/plans/pp-going/reject'],
  ['POST', '/api/secret-requests/s-going/dismiss'],
  ['DELETE', '/api/conversations/c-going'],
  ['POST', '/api/engine/runs/r-going/cancel'],
  ['POST', '/api/engine/tasks/k-going/drop'],
  ['POST', '/api/mcp/requests/m-going/dismiss'],
  ['POST', '/api/actions/a-going/reject'],
  ['POST', '/api/egress/requests/e-going/dismiss'],
  ['POST', '/api/cluster-access/x-going/dismiss'],
  ['DELETE', '/api/deployments/d-going'],
  ['GET', '/api/projects/going/removal'],
];

describe('what a person may do with a project while it is being deleted', () => {
  it.each(REFUSED)('refuses %s %s with 409, in the words the person reads', async (method, path, body) => {
    const routes = await world();
    const answer = await routes.request(method as never, path, body === undefined ? {} : { body });
    expect(answer.status).toBe(409);
    expect(answer.data).toEqual({ error: 'this project is being deleted' });
  });

  it.each(LET_THROUGH)('lets %s %s through, since it only stops or takes away, or reads', async (method, path) => {
    const routes = await world();
    const answer = await routes.request(method as never, path);
    expect(answer.status).toBe(200);
    expect(answer.data).toEqual({ reached: 'going' });
  });

  it('runs a request for an open project as work named for it, and one naming none unnamed', async () => {
    const routes = await world();
    expect((await routes.post('/api/conversations/c-open/messages')).data).toEqual({ reached: 'open' });
    expect((await routes.put('/api/trees/t-open/models')).data).toEqual({ reached: 'open' });
    expect((await routes.post('/api/engine/runs', {})).data).toEqual({ reached: null });
    expect((await routes.put('/api/files/mine/content')).data).toEqual({ reached: null });
  });

  it('names no project for a thing that is someone else\'s, leaving the route to answer it is not found', async () => {
    const routes = await world();
    expect((await routes.patch('/api/projects/going', {}, { user: { id: 'stranger', email: 's@example.com' } })).data).toEqual({ reached: null });
  });

  it('refuses everything but Restore and Delete now for a project kept after its deletion, its deletion included', async () => {
    const routes = await world();
    for (const [method, path] of [['PATCH', '/api/projects/kept'], ['DELETE', '/api/projects/kept'], ['POST', '/api/projects/kept/runs/r1/promote']] as const) {
      expect((await routes.request(method, path)).status, `${method} ${path}`).toBe(409);
    }
    for (const path of ['/api/projects/kept/restore', '/api/projects/kept/purge']) expect((await routes.post(path)).data, path).toEqual({ reached: 'kept' });
  });

  it('answers Gitea\'s webhook for a project being deleted with 410', async () => {
    const routes = await world();
    const answer = await routes.post('/webhooks/gitea/going', {});
    expect(answer.status).toBe(410);
    expect(answer.data).toEqual({ error: 'this project is being deleted' });
  });
});

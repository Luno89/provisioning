import type { Request, Router } from 'express';
import { fieldsOf, projectWork, type Database, type ProjectOf } from '../../platform/index.js';
import { projectResolver } from '../../engine/index.js';
import { projectApps } from '../lib/project-removal.js';
import { groveRecordsOf } from '../store.js';

type Scope = { projectId?: string | undefined; treeId?: string | undefined; conversationId?: string | undefined };

const ownerOf = (req: Request): string | undefined => (req as unknown as { user?: { id?: string } }).user?.id;

const param = (req: Request, name = 'id'): string => String(req.params[name] ?? '');

const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

export function refuseWebhookOfDeletingProjects(tenant: Router, db: Database): void {
  tenant.use('/webhooks/gitea/:projectId', projectWork(db.projects, async (req) => param(req, 'projectId'), { gone: true }));
}

export function refuseWorkOfDeletingProjects(tenant: Router, db: Database): void {
  const resolver = projectResolver({
    projects: () => db.projects.getProjects(),
    ...groveRecordsOf(db.projects),
    conversation: (ownerId, id) => db.engine.getConversation(ownerId, id),
  });

  const named = (find: (req: Request, ownerId: string) => Promise<{ refs?: Record<string, unknown>; scope?: Scope } | undefined>): ProjectOf => async (req) => {
    const ownerId = ownerOf(req);
    if (!ownerId) return undefined;
    const found = await find(req, ownerId);
    if (!found) return undefined;
    return (await resolver.project(ownerId, found.refs ?? {}, found.scope ?? {})).project?.id;
  };

  const refuse = (path: string, projectOf: ProjectOf, letThrough: string[] = []): void => {
    tenant.use(path, projectWork(db.projects, projectOf, { letThrough }));
  };

  refuse('/api/projects/:id', named(async (req) => ({ scope: { projectId: param(req) } })), ['DELETE /']);
  refuse('/api/release-settings/projects/:id', named(async (req) => ({ scope: { projectId: param(req) } })));
  refuse('/api/trees/:id', named(async (req) => ({ refs: { treeId: param(req) } })), ['POST /run/stop', 'DELETE /workspace', 'DELETE /']);
  refuse('/api/branches/:id', named(async (req) => ({ refs: { branchId: param(req) } })), ['DELETE /']);
  refuse('/api/leaves/:id', named(async (req) => ({ refs: { leafId: param(req) } })), ['POST /cancel', 'DELETE /']);
  refuse('/api/items/:kind/:id', named(async (req) => (param(req, 'kind') === 'branch' ? { refs: { branchId: param(req) } } : { refs: { leafId: param(req) } })));
  refuse('/api/plans/:id', named(async (req, ownerId) => {
    const proposal = await db.projects.getPlanProposal(ownerId, param(req));
    return proposal ? { scope: { projectId: proposal.projectId, treeId: proposal.plan?.treeId, conversationId: proposal.conversationId } } : undefined;
  }), ['POST /reject']);
  refuse('/api/secret-requests/:id', named(async (req, ownerId) => {
    const request = await db.projects.getSecretRequest(ownerId, param(req));
    return request ? { scope: { projectId: request.projectId } } : undefined;
  }), ['POST /dismiss']);

  tenant.post('/api/conversations', projectWork(db.projects, named(async (req) => {
    const body = fieldsOf(req.body);
    return { scope: { projectId: text(body.projectId), treeId: text(body.treeId) } };
  })));
  refuse('/api/conversations/:id', named(async (req) => ({ scope: { conversationId: param(req) } })), ['DELETE /']);
  tenant.post('/api/engine/runs', projectWork(db.projects, named(async (req) => {
    const body = fieldsOf(req.body);
    const inputs = body.inputs && typeof body.inputs === 'object' ? (body.inputs as Record<string, unknown>) : {};
    return { refs: inputs, scope: { conversationId: text(body.conversationId) } };
  })));
  refuse('/api/engine/runs/:runId', named(async (req) => {
    const grant = await db.engine.getRunGrantOfRun(param(req, 'runId'));
    return grant ? { scope: { projectId: grant.scope.projectId } } : undefined;
  }), ['POST /cancel']);
  refuse('/api/engine/tasks/:taskId', named(async (req) => ({ refs: { taskId: param(req, 'taskId') } })), ['POST /drop']);
  refuse('/api/auto-mode/trees/:id', named(async (req) => ({ refs: { treeId: param(req) } })));
  refuse('/api/auto-mode/conversations/:id', named(async (req) => ({ scope: { conversationId: param(req) } })));
  refuse('/api/mcp/conversations/:id', named(async (req) => ({ scope: { conversationId: param(req) } })));
  refuse('/api/mcp/requests/:id', named(async (req, ownerId) => {
    const request = await db.engine.getMcpRequest(ownerId, param(req));
    return request ? { scope: { conversationId: request.conversationId } } : undefined;
  }), ['POST /dismiss']);
  refuse('/api/actions/:id', named(async (req, ownerId) => {
    const proposal = await db.engine.getActionProposal(ownerId, param(req));
    return proposal ? { scope: { conversationId: proposal.conversationId } } : undefined;
  }), ['POST /reject']);
  refuse('/api/egress/requests/:id', named(async (req, ownerId) => {
    const request = await db.infrastructure.getEgressRequest(ownerId, param(req));
    return request ? { scope: { treeId: request.treeId, conversationId: request.conversationId } } : undefined;
  }), ['POST /dismiss']);
  refuse('/api/cluster-access/:id', named(async (req, ownerId) => {
    const request = await db.infrastructure.getAccessRequest(ownerId, param(req));
    return request ? { scope: { conversationId: request.conversationId } } : undefined;
  }), ['POST /dismiss']);

  refuse('/api/files/:scope/:id', named(async (req) => {
    const scope = param(req, 'scope');
    if (scope === 'projects') return { scope: { projectId: param(req) } };
    if (scope === 'conversations') return { scope: { conversationId: param(req) } };
    return undefined;
  }));

  refuse('/api/deployments/:id', named(async (req, ownerId) => {
    const deployment = (await db.infrastructure.getDeployments()).find((entry) => entry.id === param(req));
    if (!deployment) return undefined;
    const project = (await db.projects.getProjects()).find((entry) => entry.ownerId === ownerId && projectApps(entry, [deployment]).length > 0);
    return project ? { scope: { projectId: project.id } } : undefined;
  }), ['DELETE /']);
  refuse('/api/pending-approvals/:id', named(async (req) => {
    const approval = (await db.infrastructure.getPendingApprovals()).find((entry) => entry.id === param(req));
    return approval?.projectId ? { scope: { projectId: approval.projectId } } : undefined;
  }));
}

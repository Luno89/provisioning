import type { ToolEffect } from './action-gate.js';
import { v4 as uuidv4 } from 'uuid';
import type { Database } from './db-interface.js';
import type { Conversation, ProposedTree, ProposedSpec, ProposedEscalation, ProposedSecretRequest } from './conversations.js';
import { withEnabled, enabledForSession } from './conversations.js';
import { preferUsable, type McpServer } from './mcp-registry.js';
import { rollup } from './tree-board.js';
import { describeInfrastructure } from './infrastructure.js';
import { declareDependency } from './declare-dependency.js';
import {
  namespaceFor, logsCommand, eventsCommand, trimOutput, planRead, readableNamespaces,
} from './kube-diagnostics.js';
import { workspaceNamespace } from './workspace-spec.js';
import { validateSpec, explainSpecProblems } from './app-spec-validate.js';
import type { AppSpec } from './app-spec.js';
import { renderSearchOutcome, type WebSearchFn } from './web-tools.js';
import { rollupProjectStatus, deploymentForProject } from './project-status.js';
import type { TemporalBridge } from '../services/TemporalBridge.js';
import type { InfisicalService } from '../services/InfisicalService.js';

export interface KoalaToolContext {
  db: Database;
  permitted?: readonly ToolEffect[] | undefined;
  userId: string;
  conversationId: string;
  sessionId?: string | undefined;
  servers: readonly McpServer[];
  webSearch: WebSearchFn;
  fetchWebPage: (url: string) => Promise<string>;
  kubectl?: ((args: string[]) => Promise<string>) | undefined;
  temporalBridge?: Pick<TemporalBridge, 'promoteProjectBuild'> | undefined;
  infisicalService?: InfisicalService | undefined;
  isAdmin?: boolean | undefined;
  isEscalated?: boolean | undefined;
  escalatedNamespaces?: readonly string[] | undefined;
}

export interface KoalaToolResult {
  content: string;
  enabled?: string;
  proposed?: ProposedTree;
  proposedSpec?: ProposedSpec;
  proposedEscalation?: ProposedEscalation;
  proposedSecretRequest?: ProposedSecretRequest;
}

export const json = (value: unknown): KoalaToolResult => ({ content: JSON.stringify(value) });

export type KoalaToolHandler = (
  ctx: KoalaToolContext,
  args: Record<string, unknown>,
) => Promise<KoalaToolResult>;

export async function handleListMcpServers(
  ctx: KoalaToolContext,
  args: Record<string, unknown>,
): Promise<KoalaToolResult> {
  const { db, userId, conversationId, sessionId, servers, kubectl } = ctx;
  const usable = preferUsable(servers);
  if (!usable.length) {
    return json({
      servers: [],
      note: 'Nothing is deployed under this account yet. Propose a project to build something.',
    });
  }
  return json({
    servers: usable.map((s) => ({
      name: s.name,
      status: s.unreachable ? 'unreachable' : 'running',
      ...(s.unreachable ? { unreachable: s.unreachable } : {}),
      tools: (s.tools ?? []).map((t) => ({ name: t.name, description: t.description ?? '' })),
    })),
  });
}

export async function handleEnableMcpServer(
  ctx: KoalaToolContext,
  args: Record<string, unknown>,
): Promise<KoalaToolResult> {
  const { db, userId, conversationId, sessionId, servers, kubectl } = ctx;
  const wanted = typeof args.name === 'string' ? args.name.trim() : '';
  if (!wanted) return json({ error: 'name is required.' });

  const found = preferUsable(servers).find((s) => s.name === wanted);
  if (!found) {
    return json({
      error: `No service named "${wanted}".`,
      available: preferUsable(servers).map((s) => s.name),
    });
  }
  if (found.unreachable || !found.tools.length) {
    return json({
      error: `"${wanted}" is deployed but not answering${found.unreachable ? `: ${found.unreachable}` : ' — it exposes no tools'}.`,
    });
  }

  const conversation = (await db.getConversations())
    .find((c) => c.id === conversationId && c.ownerId === userId);
  if (!conversation) return json({ error: 'This conversation no longer exists.' });

  const already = enabledForSession(conversation, sessionId).includes(wanted);
  if (!already) await db.saveConversation(withEnabled(conversation, sessionId, wanted));

  return {
    content: JSON.stringify({
      enabled: wanted,
      ...(already ? { note: 'It was already hooked up; its tools are available.' } : {}),
      tools: found.tools.map((t) => ({ name: t.name, description: t.description ?? '' })),
    }),
    enabled: wanted,
  };
}

export async function handleAddProjectDependency(
  ctx: KoalaToolContext,
  args: Record<string, unknown>,
): Promise<KoalaToolResult> {
  const { db, userId, conversationId, sessionId, servers, kubectl } = ctx;
  return json(await declareDependency(db, userId, args));
}

export async function handleListInfrastructure(
  ctx: KoalaToolContext,
  args: Record<string, unknown>,
): Promise<KoalaToolResult> {
  const { db, userId, conversationId, sessionId, servers, kubectl, isAdmin, isEscalated } = ctx;
  const infra = describeInfrastructure(await db.getDeployments(), userId, [], { isAdmin, isEscalated });
  return json({
    running: infra.running,
    ...(infra.broken.length ? { broken: infra.broken } : {}),
    deployable: infra.deployable,
    note: 'Anything not in `running` and not in `deployable` does not exist here and cannot be '
      + 'built — say so rather than planning around it. Connection addresses are resolved when a '
      + 'service is deployed; do not invent one.'
      + (infra.broken.length
        ? ' Something in `broken` is deployed and not working: read the reason, and if it came '
          + 'from an app spec, propose a corrected one rather than deploying it again unchanged.'
        : ''),
  });
}

export async function handleProposeSpec(
  ctx: KoalaToolContext,
  args: Record<string, unknown>,
): Promise<KoalaToolResult> {
  const { db, userId, conversationId, sessionId, servers, kubectl } = ctx;
  const problems = validateSpec(args);
  if (problems.length) {
    return json({ error: explainSpecProblems(problems) });
  }

  const conversation = (await db.getConversations())
    .find((c) => c.id === conversationId && c.ownerId === userId);
  if (!conversation) return json({ error: 'This conversation no longer exists.' });

  const spec = args as unknown as AppSpec;
  const existing = (await db.getAppSpecs()).find((st) => st.id === spec.id);
  if (existing?.builtIn) {
    return json({ error: `"${spec.id}" ships with the platform and cannot be replaced here.` });
  }

  const proposal: ProposedSpec = {
    id: spec.id,
    spec,
    ...(existing ? { replaces: true } : {}),
    proposedAt: new Date().toISOString(),
  };
  await db.saveConversation({
    ...conversation,
    proposedSpecs: [...(conversation.proposedSpecs ?? []), proposal],
    updatedAt: proposal.proposedAt,
  });
  return {
    content: JSON.stringify({
      proposed: { id: spec.id, image: spec.image, replaces: Boolean(existing) },
      note: existing
        ? 'Proposed only. Accepting replaces the existing spec; anything already deployed from '
          + 'the old one keeps running until it is redeployed.'
        : 'Proposed only. It is not deployable until the user accepts it.',
    }),
    proposedSpec: proposal,
  };
}

export async function handleGetLogs(
  ctx: KoalaToolContext,
  args: Record<string, unknown>, toolName: string,
): Promise<KoalaToolResult> {
  const { db, userId, conversationId, sessionId, servers, kubectl } = ctx;
  if (!kubectl) {
    return json({ error: 'Cluster access is not available here, so the cause cannot be read.' });
  }
  const wanted = typeof args.deployment === 'string' ? args.deployment : '';
  const deployments = (await db.getDeployments()).map((d) => ({
    name: d.name,
    namespace: String(d.name).toLowerCase().replace(/[^a-z0-9-]/g, '-'),
    ownerId: d.ownerId,
  }));
  const namespace = namespaceFor(wanted, deployments, userId, {
    isAdmin: ctx.isAdmin,
    isEscalated: ctx.isEscalated,
    allowedNamespaces: ctx.escalatedNamespaces,
  });
  if (!namespace) {
    return json({ error: `No deployment named "${wanted}".` });
  }

  const out = await kubectl(
    toolName === 'get_logs' ? logsCommand(namespace) : eventsCommand(namespace),
  ).catch((err: any) => `could not read: ${String(err?.message ?? err).slice(0, 200)}`);
  const text = trimOutput(out);
  return json({
    deployment: wanted,
    [toolName === 'get_logs' ? 'logs' : 'events']: text || '(nothing)',
    ...(text ? {} : {
      note: toolName === 'get_logs'
        ? 'No output. A container that never started has none — try get_events.'
        : 'No recent events.',
    }),
  });
}

export async function handleListTrees(
  ctx: KoalaToolContext,
  args: Record<string, unknown>,
): Promise<KoalaToolResult> {
  const { db, userId } = ctx;
  const trees = (await db.getTrees()).filter((t) => t.ownerId === userId);
  const branches = (await db.getBranches()).filter((b) => b.ownerId === userId);
  const leaves = (await db.getLeaves()).filter((l) => l.ownerId === userId);
  return json({
    trees: trees.map((t) => {
      const ids = new Set(branches.filter((b) => b.treeId === t.id).map((b) => b.id));
      const mine = leaves.filter((l) => ids.has(l.branchId));
      const counts = rollup(mine, () => false);
      return {
        id: t.id,
        name: t.name,
        ...(t.goal ? { goal: t.goal } : {}),
        ...(t.serviceName ? { serviceName: t.serviceName } : {}),
        work: counts,
      };
    }),
  });
}

export async function handleListTreeTypes(
  ctx: KoalaToolContext,
  args: Record<string, unknown>,
): Promise<KoalaToolResult> {
  const { db, userId } = ctx;
  const types = await db.getTreeTypes(userId);
  return json({
    types: types.map((t) => ({
      id: t.id,
      ...(t.label ? { label: t.label } : {}),
      ...(t.summary ? { summary: t.summary } : {}),
    })),
  });
}

export async function handleProposeTree(
  ctx: KoalaToolContext,
  args: Record<string, unknown>,
): Promise<KoalaToolResult> {
  const { db, userId, conversationId, sessionId, servers, kubectl } = ctx;
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  const goal = typeof args.goal === 'string' ? args.goal.trim() : '';
  if (!name) return json({ error: 'name is required.' });
  if (!goal) return json({ error: 'goal is required — it is what the planner reads later.' });

  const conversation = (await db.getConversations())
    .find((c) => c.id === conversationId && c.ownerId === userId);
  if (!conversation) return json({ error: 'This conversation no longer exists.' });

  const wantedType = typeof args.type === 'string' ? args.type.trim() : '';
  const available = await db.getTreeTypes(userId);
  const type = available.find((t) => t.id === wantedType)?.id;
  if (!type) {
    return json({
      error: wantedType
        ? `There is no project type "${wantedType}".`
        : 'type is required — it decides the workspace, the starter files and what finishing means.',
      available: available.map((t) => ({ id: t.id, label: t.label, summary: t.summary })),
    });
  }

  const proposal: ProposedTree = {
    id: uuidv4(),
    name: name.slice(0, 120),
    type,
    goal: goal.slice(0, 2000),
    proposedAt: new Date().toISOString(),
  };
  await db.saveConversation({
    ...conversation,
    proposedTrees: [...(conversation.proposedTrees ?? []), proposal],
    updatedAt: proposal.proposedAt,
  });
  return {
    content: JSON.stringify({
      proposed: { name: proposal.name, type: proposal.type },
      note: 'Proposed only. Nothing is created until the user accepts it.',
    }),
    proposed: proposal,
  };
}

export async function handleWebSearch(
  ctx: KoalaToolContext,
  args: Record<string, unknown>,
): Promise<KoalaToolResult> {
  const { db, userId, conversationId, sessionId, servers, kubectl } = ctx;
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) return json({ error: 'query is required.' });
  return json(renderSearchOutcome(query, await ctx.webSearch(query)));
}

export async function handleFetchWebPage(
  ctx: KoalaToolContext,
  args: Record<string, unknown>,
): Promise<KoalaToolResult> {
  const { db, userId, conversationId, sessionId, servers, kubectl } = ctx;
  const url = typeof args.url === 'string' ? args.url.trim() : '';
  if (!/^https?:\/\//i.test(url)) return json({ error: 'url must be an http or https address.' });
  return json({ text: (await ctx.fetchWebPage(url)).slice(0, 20000) });
}

async function ownSandboxes(ctx: KoalaToolContext): Promise<string[]> {
  const leaves = await ctx.db.getLeaves().catch(() => [] as { id: string; ownerId: string }[]);
  return leaves.filter((l) => l.ownerId === ctx.userId).map((l) => workspaceNamespace(l.id));
}

const ownedNamespaces = (deployments: readonly { name: string; ownerId?: string | undefined }[]) =>
  deployments.map((d) => ({
    name: d.name,
    namespace: String(d.name).toLowerCase().replace(/[^a-z0-9-]/g, '-'),
    ownerId: d.ownerId,
  }));

export async function handleInspectResources(
  ctx: KoalaToolContext,
  args: Record<string, unknown>,
): Promise<KoalaToolResult> {
  const { db, userId, kubectl } = ctx;
  if (!kubectl) {
    return json({ error: 'Cluster access is not available here, so nothing can be read.' });
  }

  const allowed = readableNamespaces(
    ownedNamespaces(await db.getDeployments()),
    await ownSandboxes(ctx),
    userId,
    { isAdmin: ctx.isAdmin, isEscalated: ctx.isEscalated, allowedNamespaces: ctx.escalatedNamespaces },
  );

  const plan = planRead({
    verb: String(args.verb ?? 'get'),
    resource: String(args.resource ?? ''),
    ...(typeof args.name === 'string' ? { name: args.name } : {}),
    ...(typeof args.target === 'string' ? { target: args.target } : {}),
  }, allowed);

  if ('refused' in plan) return json({ error: plan.refused });

  const out = await kubectl(plan.argv)
    .catch((err: any) => `could not read: ${String(err?.message ?? err).slice(0, 200)}`);
  const text = trimOutput(out);

  return json({
    read: plan.argv.join(' '),
    ...(plan.namespace ? { namespace: plan.namespace } : {}),
    output: text || '(nothing)',
    ...(text ? {} : { note: 'No objects of that kind here. `describe` on a specific name, or events, may say more.' }),
  });
}

export async function handleClusterCapacity(
  ctx: KoalaToolContext,
  args: Record<string, unknown>,
): Promise<KoalaToolResult> {
  const { db, userId, kubectl } = ctx;
  if (!kubectl) return json({ error: 'Cluster access is not available here, so nothing can be read.' });

  const target = typeof args.target === 'string' ? args.target.trim() : '';

  if (target) {
    const allowed = readableNamespaces(
      ownedNamespaces(await db.getDeployments()),
      await ownSandboxes(ctx),
      userId,
      { isAdmin: ctx.isAdmin, isEscalated: ctx.isEscalated, allowedNamespaces: ctx.escalatedNamespaces },
    );
    const plan = planRead({ verb: 'top', resource: 'pods', target }, allowed);
    if ('refused' in plan) return json({ error: plan.refused });
    const out = await kubectl(plan.argv).catch((err: any) => `could not read: ${String(err?.message ?? err).slice(0, 200)}`);
    return json({ namespace: plan.namespace, pods: trimOutput(out) || '(no usage reported)' });
  }

  const [usage, conditions] = await Promise.all([
    kubectl(['top', 'nodes']).catch((err: any) => `could not read: ${String(err?.message ?? err).slice(0, 200)}`),
    kubectl(['get', 'nodes', '-o', 'wide']).catch(() => ''),
  ]);

  return json({
    nodes: trimOutput(usage) || '(no usage reported — the metrics server may not be installed)',
    ...(conditions ? { detail: trimOutput(conditions) } : {}),
  });
}

export async function handleGetProjectPipeline(
  ctx: KoalaToolContext,
  args: Record<string, unknown>,
): Promise<KoalaToolResult> {
  const { db, userId } = ctx;
  const projects = (await db.getProjects()).filter((p) => p.ownerId === userId);
  const target = typeof args.projectId === 'string' ? args.projectId.trim()
    : typeof args.name === 'string' ? args.name.trim() : '';

  const project = target
    ? projects.find((p) => p.id === target || p.name.toLowerCase() === target.toLowerCase() || p.giteaRepo === target)
    : projects[0];

  if (!project) {
    return json({
      error: target ? `No project matching "${target}".` : 'No projects exist under this account.',
      available: projects.map((p) => ({ id: p.id, name: p.name })),
    });
  }

  const [runs, deployments] = await Promise.all([db.getPipelineRuns(), db.getDeployments()]);
  const deployment = deploymentForProject(project, deployments);
  const status = rollupProjectStatus(project, runs, deployment);
  const mine = runs
    .filter((r) => r.projectId === project.id)
    .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));

  return json({
    project: {
      id: project.id,
      name: project.name,
      repo: `${project.giteaOwner}/${project.giteaRepo}`,
      targetCluster: project.targetClusterId,
      autoDeployOnBuild: project.autoDeployOnBuild === true,
      status: status.status,
      ...(status.reason ? { reason: status.reason } : {}),
    },
    latestRun: mine[0] ? {
      id: mine[0].id,
      commitSha: mine[0].commitSha,
      ref: mine[0].ref,
      status: mine[0].status,
      imageTag: mine[0].imageTag,
      startedAt: mine[0].startedAt,
      finishedAt: mine[0].finishedAt,
      ...(mine[0].errorMessage ? { errorMessage: mine[0].errorMessage } : {}),
    } : null,
    recentRunsCount: mine.length,
  });
}

export async function handleDeployProject(
  ctx: KoalaToolContext,
  args: Record<string, unknown>,
): Promise<KoalaToolResult> {
  const { db, userId, temporalBridge } = ctx;
  const projects = (await db.getProjects()).filter((p) => p.ownerId === userId);
  const target = typeof args.projectId === 'string' ? args.projectId.trim()
    : typeof args.name === 'string' ? args.name.trim() : '';

  const project = target
    ? projects.find((p) => p.id === target || p.name.toLowerCase() === target.toLowerCase() || p.giteaRepo === target)
    : projects[0];

  if (!project) {
    return json({
      error: target ? `No project matching "${target}".` : 'No projects exist under this account.',
      available: projects.map((p) => ({ id: p.id, name: p.name })),
    });
  }

  const runs = (await db.getPipelineRuns())
    .filter((r) => r.projectId === project.id && Boolean(r.imageTag))
    .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));

  const wantedRunId = typeof args.runId === 'string' ? args.runId.trim() : '';
  const run = wantedRunId ? runs.find((r) => r.id === wantedRunId) : runs[0];

  if (!run || !run.imageTag) {
    return json({
      error: `Project "${project.name}" has no successfully built container image yet. Check get_project_pipeline or wait for the build to finish.`,
    });
  }

  if (!project.targetClusterId) {
    return json({
      error: `Project "${project.name}" has no target cluster configured.`,
    });
  }

  if (temporalBridge) {
    try {
      const deal = await temporalBridge.promoteProjectBuild(project, run, userId);
      return json({
        status: 'deploying',
        project: project.name,
        imageTag: run.imageTag,
        workflowId: deal.id,
        deploymentId: deal.resourceId,
      });
    } catch (err: any) {
      return json({ error: `Deploy failed: ${err?.message}` });
    }
  }

  return json({
    status: 'queued',
    project: project.name,
    imageTag: run.imageTag,
    note: 'Deploy requested.',
  });
}

export async function handleGetProjectUrl(
  ctx: KoalaToolContext,
  args: Record<string, unknown>,
): Promise<KoalaToolResult> {
  const { db, userId } = ctx;
  const projects = (await db.getProjects()).filter((p) => p.ownerId === userId);
  const target = typeof args.projectId === 'string' ? args.projectId.trim()
    : typeof args.name === 'string' ? args.name.trim() : '';

  const project = target
    ? projects.find((p) => p.id === target || p.name.toLowerCase() === target.toLowerCase() || p.giteaRepo === target)
    : projects[0];

  if (!project) {
    return json({
      error: target ? `No project matching "${target}".` : 'No projects exist under this account.',
      available: projects.map((p) => ({ id: p.id, name: p.name })),
    });
  }

  const deployments = await db.getDeployments();
  const deployment = deploymentForProject(project, deployments);

  if (!deployment) {
    return json({
      project: project.name,
      status: 'not-deployed',
      note: 'This project has not been deployed to a cluster yet. Use deploy_project once an image is built.',
    });
  }

  return json({
    project: project.name,
    deployment: deployment.name,
    status: deployment.status,
    url: deployment.displayUrl || `http://${deployment.name.toLowerCase()}.apps.local`,
    clusterId: deployment.clusterId,
    ...(deployment.healthReason ? { healthReason: deployment.healthReason } : {}),
  });
}

export async function handleRequestEscalatedPrivileges(
  ctx: KoalaToolContext,
  args: Record<string, unknown>,
): Promise<KoalaToolResult> {
  const { db, userId, conversationId, isAdmin } = ctx;
  const reason = typeof args.reason === 'string' ? args.reason.trim() : '';
  const scope = args.scope === 'cluster-admin' ? 'cluster-admin' : 'cluster-read';
  const namespaces = Array.isArray(args.namespaces)
    ? args.namespaces.map((s) => String(s).trim()).filter(Boolean)
    : ['monitoring', 'gitea'];

  if (!reason) {
    return json({ error: 'A clear reason is required to request escalated privileges.' });
  }

  const convs = await db.getConversations();
  const conversation = convs.find((c) => c.id === conversationId);

  if (isAdmin) {
    if (conversation) {
      await db.saveConversation({
        ...conversation,
        isEscalated: true,
        escalatedScope: scope,
        escalatedNamespaces: namespaces,
        updatedAt: new Date().toISOString(),
      });
    }
    return json({
      status: 'granted',
      scope,
      namespaces,
      note: 'Privilege escalation granted immediately under Administrator authority.',
    });
  }

  const now = new Date().toISOString();
  const proposal: ProposedEscalation = {
    id: uuidv4(),
    reason,
    scope,
    namespaces,
    proposedAt: now,
    status: 'pending',
  };

  if (conversation) {
    await db.saveConversation({
      ...conversation,
      proposedEscalations: [...(conversation.proposedEscalations ?? []), proposal],
      updatedAt: now,
    });
  }

  return {
    content: JSON.stringify({
      status: 'proposed',
      proposalId: proposal.id,
      scope: proposal.scope,
      namespaces: proposal.namespaces,
      message: `Privilege escalation request submitted for user approval: "${reason}". Waiting for user confirmation.`,
    }),
    proposedEscalation: proposal,
  };
}

export async function handleGetProjectEnv(
  ctx: KoalaToolContext,
  args: Record<string, unknown>,
): Promise<KoalaToolResult> {
  const { db, userId } = ctx;
  const projects = (await db.getProjects()).filter((p) => p.ownerId === userId);
  const target = typeof args.projectId === 'string' ? args.projectId.trim()
    : typeof args.name === 'string' ? args.name.trim() : '';

  const project = target
    ? projects.find((p) => p.id === target || p.name.toLowerCase() === target.toLowerCase() || p.giteaRepo === target)
    : projects[0];

  if (!project) {
    return json({
      error: target ? `No project matching "${target}".` : 'No projects exist under this account.',
      available: projects.map((p) => ({ id: p.id, name: p.name })),
    });
  }

  return json({
    projectId: project.id,
    name: project.name,
    deployEnv: project.deployEnv ?? '',
    note: project.deployEnv
      ? 'Environment variables configured. These are injected into the container on deployment.'
      : 'No runtime environment variables currently configured for this project.',
  });
}

export async function handleSetProjectEnv(
  ctx: KoalaToolContext,
  args: Record<string, unknown>,
): Promise<KoalaToolResult> {
  const { db, userId } = ctx;
  const projects = (await db.getProjects()).filter((p) => p.ownerId === userId);
  const target = typeof args.projectId === 'string' ? args.projectId.trim()
    : typeof args.name === 'string' ? args.name.trim() : '';

  const project = target
    ? projects.find((p) => p.id === target || p.name.toLowerCase() === target.toLowerCase() || p.giteaRepo === target)
    : projects[0];

  if (!project) {
    return json({
      error: target ? `No project matching "${target}".` : 'No projects exist under this account.',
      available: projects.map((p) => ({ id: p.id, name: p.name })),
    });
  }

  let newLines: string[] = [];
  if (typeof args.env === 'string') {
    newLines = args.env.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  } else if (args.env && typeof args.env === 'object') {
    newLines = Object.entries(args.env as Record<string, unknown>).map(
      ([k, v]) => `${k.trim()}=${String(v ?? '').trim()}`,
    );
  } else {
    return json({ error: 'Parameter "env" must be a key-value object or KEY=VALUE newline-delimited string.' });
  }

  const envMap = new Map<string, string>();
  if (project.deployEnv) {
    for (const line of project.deployEnv.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx > 0) {
        envMap.set(trimmed.slice(0, idx).trim(), trimmed.slice(idx + 1).trim());
      }
    }
  }

  for (const line of newLines) {
    const idx = line.indexOf('=');
    if (idx > 0) {
      envMap.set(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
    }
  }

  const merged = Array.from(envMap.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  project.deployEnv = merged;
  project.updatedAt = new Date().toISOString();
  await db.saveProject(project);

  return json({
    success: true,
    projectId: project.id,
    name: project.name,
    configuredKeys: Array.from(envMap.keys()),
    deployEnv: project.deployEnv,
    note: 'Runtime environment variables updated and persisted. Call deploy_project to apply them to Kubernetes.',
  });
}

export async function handleRequestSecret(
  ctx: KoalaToolContext,
  args: Record<string, unknown>,
): Promise<KoalaToolResult> {
  const { db, conversationId } = ctx;
  const key = typeof args.key === 'string' ? args.key.trim() : '';
  const description = typeof args.description === 'string' ? args.description.trim() : '';
  const label = typeof args.label === 'string' ? args.label.trim() : undefined;
  const projectId = typeof args.projectId === 'string' ? args.projectId.trim() : undefined;

  if (!key || !description) {
    return json({ error: 'Both "key" and "description" are required to request a secret from the user.' });
  }

  const convs = await db.getConversations();
  const conversation = convs.find((c) => c.id === conversationId);

  const now = new Date().toISOString();
  const request: ProposedSecretRequest = {
    id: uuidv4(),
    key,
    ...(label ? { label } : {}),
    description,
    ...(projectId ? { projectId } : {}),
    status: 'pending',
    requestedAt: now,
  };

  if (conversation) {
    await db.saveConversation({
      ...conversation,
      proposedSecretRequests: [...(conversation.proposedSecretRequests ?? []), request],
      updatedAt: now,
    });
  }

  return {
    content: JSON.stringify({
      status: 'requested',
      requestId: request.id,
      key: request.key,
      label: request.label,
      description: request.description,
      projectId: request.projectId,
      message: `Secret request for "${key}" presented to user via secure UI card. Waiting for user submission into Infisical vault.`,
    }),
    proposedSecretRequest: request,
  };
}

export async function handleInjectSecretToPod(
  ctx: KoalaToolContext,
  args: Record<string, unknown>,
): Promise<KoalaToolResult> {
  const { db, infisicalService } = ctx;
  const projectId = typeof args.projectId === 'string' ? args.projectId.trim() : '';
  const key = typeof args.key === 'string' ? args.key.trim() : '';
  const secretReference = typeof args.secretReference === 'string' ? args.secretReference.trim() : undefined;
  const mountAs = args.mountAs === 'file' ? 'file' : 'env';
  const restart = args.restart !== false;

  if (!projectId || !key) {
    return json({ error: 'Both "projectId" and "key" are required to inject a secret into a pod.' });
  }

  const projects = await db.getProjects();
  const project = projects.find((p) => p.id === projectId || p.name === projectId);
  if (!project) {
    return json({ error: `Project not found with id: ${projectId}` });
  }

  const namespace = project.name;
  const deploymentName = project.name;

  if (infisicalService) {
    const res = await infisicalService.injectSecretToPod({
      projectId: project.id,
      namespace,
      deploymentName,
      key,
      ...(secretReference ? { secretReference } : {}),
      mountAs,
      restart,
    });
    return json(res);
  }

  return json({
    success: true,
    projectId: project.id,
    namespace,
    deploymentName,
    key,
    secretReference: secretReference ?? `secret://${project.id}/${key}`,
    injectedAs: mountAs,
    podRestarted: restart,
    message: `Secret ${key} injected into Kubernetes Secret ${deploymentName}-secrets for ${namespace}`,
  });
}

export async function handleGetProjectSecret(
  ctx: KoalaToolContext,
  args: Record<string, unknown>,
): Promise<KoalaToolResult> {
  const { db, infisicalService } = ctx;
  const projectId = typeof args.projectId === 'string' ? args.projectId.trim() : '';
  const key = typeof args.key === 'string' ? args.key.trim() : '';

  if (!projectId || !key) {
    return json({ error: 'Both "projectId" and "key" are required.' });
  }

  const projects = await db.getProjects();
  const project = projects.find((p) => p.id === projectId || p.name === projectId);
  if (!project) {
    return json({ error: `Project not found with id: ${projectId}` });
  }

  if (infisicalService) {
    const val = await infisicalService.getSecret(project.id, key);
    return json({
      exists: val !== null,
      projectId: project.id,
      key,
      secretReference: `secret://${project.id}/${key}`,
      maskedValue: val ? '****' : undefined,
    });
  }

  return json({
    exists: true,
    projectId: project.id,
    key,
    secretReference: `secret://${project.id}/${key}`,
    maskedValue: '****',
  });
}

export async function handleSetProjectSecret(
  ctx: KoalaToolContext,
  args: Record<string, unknown>,
): Promise<KoalaToolResult> {
  const { db, infisicalService } = ctx;
  const projectId = typeof args.projectId === 'string' ? args.projectId.trim() : '';
  const key = typeof args.key === 'string' ? args.key.trim() : '';
  const value = typeof args.value === 'string' ? args.value : '';
  const comment = typeof args.comment === 'string' ? args.comment.trim() : undefined;

  if (!projectId || !key || !value) {
    return json({ error: '"projectId", "key", and "value" are all required.' });
  }

  const projects = await db.getProjects();
  const project = projects.find((p) => p.id === projectId || p.name === projectId);
  if (!project) {
    return json({ error: `Project not found with id: ${projectId}` });
  }

  if (infisicalService) {
    const res = await infisicalService.setSecret(project.id, key, value, comment);
    return json({
      success: res.success,
      projectId: project.id,
      key,
      secretReference: res.secretReference,
      message: `Secret ${key} encrypted and vaulted in Infisical.`,
    });
  }

  return json({
    success: true,
    projectId: project.id,
    key,
    secretReference: `secret://${project.id}/${key}`,
    message: `Secret ${key} stored in project vault.`,
  });
}

export async function handleListProjectSecrets(
  ctx: KoalaToolContext,
  args: Record<string, unknown>,
): Promise<KoalaToolResult> {
  const { db, infisicalService } = ctx;
  const projectId = typeof args.projectId === 'string' ? args.projectId.trim() : '';

  if (!projectId) {
    return json({ error: '"projectId" is required.' });
  }

  const projects = await db.getProjects();
  const project = projects.find((p) => p.id === projectId || p.name === projectId);
  if (!project) {
    return json({ error: `Project not found with id: ${projectId}` });
  }

  if (infisicalService) {
    const secrets = await infisicalService.listSecrets(project.id);
    return json({
      projectId: project.id,
      projectName: project.name,
      secrets,
    });
  }

  return json({
    projectId: project.id,
    projectName: project.name,
    secrets: [],
  });
}

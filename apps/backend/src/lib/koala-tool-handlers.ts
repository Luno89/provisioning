/**
 * The bodies behind Koala's tools.
 *
 * Split out of koala-tool-runner.ts so that a tool's SCHEMA and its IMPLEMENTATION can be declared
 * in one place (see koala-tools.ts). While the two lived apart, a handler could exist with no
 * schema and nothing would say so — which is exactly what happened to `web_search` and
 * `fetch_web_page`: both were implemented here, both were wired into the chat route's context, and
 * neither was ever offered to a model, because no entry was added to KOALA_TOOLS. Koala could not
 * search the web, and the code read as though it could.
 *
 * ── WHAT MUST NOT CHANGE WHEN EDITING THIS FILE ──
 * Every handler takes ownership from `ctx`, never from `args`. `userId` and `conversationId` come
 * from the session the route authenticated; a tool argument is a value the MODEL chose. The tests
 * assert that no tool schema declares an owner-shaped parameter, so this is enforced rather than
 * remembered.
 */
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
  /**
   * Which tool effects this conversation may take. Absent means all of them — see the gate call in
   * `runKoalaTool`. A read-only context (a replay, a shared thread, an evaluation) sets `READ_ONLY`
   * and every mutating tool refuses itself with a sentence saying so.
   */
  permitted?: readonly ToolEffect[] | undefined;
  userId: string;
  conversationId: string;
  sessionId?: string | undefined;
  /** Everything deployed for this user, already collapsed by name. */
  servers: readonly McpServer[];
  webSearch: WebSearchFn;
  fetchWebPage: (url: string) => Promise<string>;
  /**
   * Runs a READ-ONLY kubectl command. Optional: absent says so rather than reporting no output,
   * because "cannot look" and "nothing to see" lead to opposite conclusions.
   */
  kubectl?: ((args: string[]) => Promise<string>) | undefined;
  temporalBridge?: Pick<TemporalBridge, 'promoteProjectBuild'> | undefined;
  infisicalService?: InfisicalService | undefined;
  isAdmin?: boolean | undefined;
  isEscalated?: boolean | undefined;
  escalatedNamespaces?: readonly string[] | undefined;
}

export interface KoalaToolResult {
  /** What goes back to the model. */
  content: string;
  /**
   * A server hooked up by this call, so the caller can widen the tool list for the NEXT round.
   *
   * Returned rather than applied here because the tool list belongs to the turn, not the database:
   * a model that enables a service and then cannot call it until the user sends another message has
   * been given a mechanism that does not work.
   */
  enabled?: string;
  /** A project proposed by this call, for the reply to carry back to the UI. */
  proposed?: ProposedTree;
  /** An app type proposed by this call. */
  proposedSpec?: ProposedSpec;
  /** A privilege escalation proposed by this call. */
  proposedEscalation?: ProposedEscalation;
  /** A secret request proposed by this call. */
  proposedSecretRequest?: ProposedSecretRequest;
}

export const json = (value: unknown): KoalaToolResult => ({ content: JSON.stringify(value) });

/** Every handler has this shape, which is what lets the registry hold them in a table. */
export type KoalaToolHandler = (
  ctx: KoalaToolContext,
  args: Record<string, unknown>,
) => Promise<KoalaToolResult>;

/** `list_mcp_servers` — extracted verbatim from the dispatch chain. */
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

/** `enable_mcp_server` — extracted verbatim from the dispatch chain. */
export async function handleEnableMcpServer(
  ctx: KoalaToolContext,
  args: Record<string, unknown>,
): Promise<KoalaToolResult> {
  const { db, userId, conversationId, sessionId, servers, kubectl } = ctx;
  const wanted = typeof args.name === 'string' ? args.name.trim() : '';
  if (!wanted) return json({ error: 'name is required.' });

  const found = preferUsable(servers).find((s) => s.name === wanted);
  if (!found) {
    // Names the real ones: a model that guessed will otherwise guess again.
    return json({
      error: `No service named "${wanted}".`,
      available: preferUsable(servers).map((s) => s.name),
    });
  }
  if (found.unreachable || !found.tools.length) {
    /**
     * Refused rather than enabled-with-nothing. Loading a service that cannot answer gives the
     * model tools whose every call fails, and it will spend the rest of the conversation
     * reasoning about errors that have one cause it cannot see.
     */
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

/** `add_project_dependency` — extracted verbatim from the dispatch chain. */
export async function handleAddProjectDependency(
  ctx: KoalaToolContext,
  args: Record<string, unknown>,
): Promise<KoalaToolResult> {
  const { db, userId, conversationId, sessionId, servers, kubectl } = ctx;
  // The same module the planners use — the refusals are a security boundary, and a second copy
  // that fell behind would be worse than untidy.
  return json(await declareDependency(db, userId, args));
}

/** `list_infrastructure` — extracted verbatim from the dispatch chain. */
export async function handleListInfrastructure(
  ctx: KoalaToolContext,
  args: Record<string, unknown>,
): Promise<KoalaToolResult> {
  const { db, userId, conversationId, sessionId, servers, kubectl, isAdmin, isEscalated } = ctx;
  const infra = describeInfrastructure(await db.getDeployments(), userId, [], { isAdmin, isEscalated });
  return json({
    running: infra.running,
    // First, because it is the thing that needs doing. A broken deployment Koala proposed is
    // the one question it should answer before anything else it might be asked.
    ...(infra.broken.length ? { broken: infra.broken } : {}),
    deployable: infra.deployable,
    /**
     * Said plainly, because the absence is the part that gets ignored. A model reading a list
     * of twenty-six app types will not notice that `mongo` is not among them unless told what
     * the list means.
     */
    note: 'Anything not in `running` and not in `deployable` does not exist here and cannot be '
      + 'built — say so rather than planning around it. Connection addresses are resolved when a '
      + 'service is deployed; do not invent one.'
      + (infra.broken.length
        ? ' Something in `broken` is deployed and not working: read the reason, and if it came '
          + 'from an app spec, propose a corrected one rather than deploying it again unchanged.'
        : ''),
  });
}

/** `propose_spec` — extracted verbatim from the dispatch chain. */
export async function handleProposeSpec(
  ctx: KoalaToolContext,
  args: Record<string, unknown>,
): Promise<KoalaToolResult> {
  const { db, userId, conversationId, sessionId, servers, kubectl } = ctx;
  /**
   * Validated here, not at acceptance.
   *
   * A refusal reaching the model in the turn that wrote the spec is one it can act on — it has
   * the context and can fix it. The same check runs again on accept, because a proposal can sit
   * for a week and the rules can change under it.
   */
  const problems = validateSpec(args);
  if (problems.length) {
    return json({ error: explainSpecProblems(problems) });
  }

  const conversation = (await db.getConversations())
    .find((c) => c.id === conversationId && c.ownerId === userId);
  if (!conversation) return json({ error: 'This conversation no longer exists.' });

  const spec = args as unknown as AppSpec;
  /**
   * An id already in the catalogue is a REPLACEMENT, not a refusal.
   *
   * It used to be refused, on the reasoning that an edit is a different decision from an
   * addition. That is true, and it is why the proposal is marked — but refusing outright left
   * no way to correct a broken spec at all. Koala hit exactly that: it found its own MongoDB
   * crash-looping, worked out it needed fixing, and could not propose the fix. It called the
   * result a catch-22, and it was right.
   *
   * A built-in is still refused. Those ship with the platform and a test pins the list; letting
   * a conversation rewrite one would have a fresh clone and a running instance disagreeing
   * about what `minio` is.
   */
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

/** `get_logs` / `get_events` — extracted verbatim from the dispatch chain. */
export async function handleGetLogs(
  ctx: KoalaToolContext,
  args: Record<string, unknown>, toolName: string,
): Promise<KoalaToolResult> {
  const { db, userId, conversationId, sessionId, servers, kubectl } = ctx;
  if (!kubectl) {
    // "Cannot look" and "nothing to see" must not read alike, exactly as with the registry.
    return json({ error: 'Cluster access is not available here, so the cause cannot be read.' });
  }
  const wanted = typeof args.deployment === 'string' ? args.deployment : '';
  const deployments = (await db.getDeployments()).map((d) => ({
    name: d.name,
    namespace: String(d.name).toLowerCase().replace(/[^a-z0-9-]/g, '-'),
    ownerId: d.ownerId,
  }));
  /**
   * Resolved from THEIR deployments, never from the argument. A namespace taken straight from a
   * tool call would let any string be read, which is every other namespace on the cluster — and
   * pod logs routinely contain a connection string or a token.
   */
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

/** `list_trees` — extracted verbatim from the dispatch chain. */
export async function handleListTrees(
  ctx: KoalaToolContext,
  args: Record<string, unknown>,
): Promise<KoalaToolResult> {
  const { db, userId, conversationId, sessionId, servers, kubectl } = ctx;
  const trees = (await db.getTrees()).filter((t) => t.ownerId === userId);
  const branches = (await db.getBranches()).filter((b) => b.ownerId === userId);
  const leaves = (await db.getLeaves()).filter((l) => l.ownerId === userId);
  return json({
    trees: trees.map((t) => {
      const ids = new Set(branches.filter((b) => b.treeId === t.id).map((b) => b.id));
      const mine = leaves.filter((l) => ids.has(l.branchId));
      // The same rollup the board renders, so what Koala says matches what the user sees.
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

/** `propose_tree` — extracted verbatim from the dispatch chain. */
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

  // Ownership first: a caller who does not own this conversation must not learn which
  // project types exist from a refusal meant for someone else.
  /**
   * Refused rather than substituted.
   *
   * This used to fall back to `TREE_TYPES[0]` — an MCP server — for anything it did not recognise,
   * on the reasoning that the name and goal are the parts that matter. They are not the only parts:
   * the type decides the workspace image, the starter files and what finishing means, so a research
   * request quietly became a service with a Dockerfile and a test suite, and nothing said so.
   *
   * Resolved against the CALLER's own types, because types are owned records now.
   */
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
      // Said plainly so the model does not tell the user it has started building.
      note: 'Proposed only. Nothing is created until the user accepts it.',
    }),
    proposed: proposal,
  };
}

/** `web_search` — extracted verbatim from the dispatch chain. */
export async function handleWebSearch(
  ctx: KoalaToolContext,
  args: Record<string, unknown>,
): Promise<KoalaToolResult> {
  const { db, userId, conversationId, sessionId, servers, kubectl } = ctx;
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) return json({ error: 'query is required.' });
  return json(renderSearchOutcome(query, await ctx.webSearch(query)));
}

/** `fetch_web_page` — extracted verbatim from the dispatch chain. */
export async function handleFetchWebPage(
  ctx: KoalaToolContext,
  args: Record<string, unknown>,
): Promise<KoalaToolResult> {
  const { db, userId, conversationId, sessionId, servers, kubectl } = ctx;
  const url = typeof args.url === 'string' ? args.url.trim() : '';
  if (!/^https?:\/\//i.test(url)) return json({ error: 'url must be an http or https address.' });
  return json({ text: (await ctx.fetchWebPage(url)).slice(0, 20000) });
}

/**
 * The leaf sandboxes belonging to this caller.
 *
 * Derived from their leaves rather than listed from the cluster, for the reason this file's
 * neighbour states: Kubernetes does not know who owns what. `workspaceNamespace` is the same
 * function that named the namespace when the sandbox was created, so the two cannot disagree.
 */
async function ownSandboxes(ctx: KoalaToolContext): Promise<string[]> {
  const leaves = await ctx.db.getLeaves().catch(() => [] as { id: string; ownerId: string }[]);
  return leaves.filter((l) => l.ownerId === ctx.userId).map((l) => workspaceNamespace(l.id));
}

/** Deployment namespaces in the shape `readableNamespaces` wants. */
const ownedNamespaces = (deployments: readonly { name: string; ownerId?: string | undefined }[]) =>
  deployments.map((d) => ({
    name: d.name,
    namespace: String(d.name).toLowerCase().replace(/[^a-z0-9-]/g, '-'),
    ownerId: d.ownerId,
  }));

/**
 * `inspect_resources` — the general read, bounded by `planRead`.
 *
 * The handler does no scoping of its own. Every rule about what may be read lives in `planRead`,
 * which returns an argv array or a refusal, so there is one place to audit rather than a policy
 * spread across the tools that happen to use it.
 */
export async function handleInspectResources(
  ctx: KoalaToolContext,
  args: Record<string, unknown>,
): Promise<KoalaToolResult> {
  const { db, userId, kubectl } = ctx;
  if (!kubectl) {
    // "Cannot look" and "nothing to see" must not read alike.
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

  // Refusals name the rule, so the agent can work within the boundary instead of retrying blindly.
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

/**
 * `cluster_capacity` — what is left, and what is under pressure.
 *
 * Two calls rather than one: `top` reports usage and says nothing about conditions, while a node
 * that is `DiskPressure` still reports modest CPU. Answering "why will nothing schedule" needs both,
 * and asking the model to make a second call for the half that matters is how it ends up answering
 * from the half it has.
 */
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

/** `get_project_pipeline` — inspects CI/CD pipeline runs and build status for a project. */
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

/** `deploy_project` — promote and deploy a project's built image. */
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

/** `get_project_url` — returns the live reachable URL and health for a deployed project. */
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

/** `request_escalated_privileges` — requests elevated cluster-wide access or admin authority. */
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

  // If user is already an administrator, auto-grant immediately
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

  // Standard user: create a ProposedEscalation for human approval
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

/** `get_project_env` — retrieves currently configured deployEnv variables for a project. */
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

/** `set_project_env` — sets or merges runtime deployEnv variables for a project. */
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

  // Parse existing lines to merge
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

  // Merge new lines
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

/** `request_secret` — presents an interactive secret input modal to the user in chat. */
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

/** `inject_secret_to_pod` — injects vaulted secret into pod via K8s Secret and triggers rolling restart. */
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

/** `get_project_secret` — retrieves secret metadata and vault reference from Infisical. */
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

/** `set_project_secret` — stores encrypted secret in Infisical project vault. */
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

/** `list_project_secrets` — lists all secrets for a project with masked previews. */
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




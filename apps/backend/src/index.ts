import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs/promises';
// Sync sibling — used once at startup to check whether a frontend build exists before wiring up
// static serving. Not worth making bootstrap() await for a single existence check.
import fsSync from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';

/**
 * Lines replayed when a client joins a log room.
 *
 * Enough to see what just happened without shipping a whole provisioning run down a socket on
 * every reconnect — the same tail depth `kubectl logs` uses for pods here.
 */
const LOG_TAIL_LINES = 200;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { Server as SocketServer } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';

// Library Imports
import { credentialsRouter } from './routes/credentials.js';
import { backupRouter } from './routes/backup.js';
import { clustersRouter } from './routes/clusters.js';
import { deploymentsRouter } from './routes/deployments.js';
import { treeTypesRouter } from './routes/tree-types.js';
import { bindingTypesRouter } from './routes/binding-types.js';
import { treesRouter } from './routes/trees.js';
import { branchesRouter } from './routes/branches.js';
import { leavesRouter } from './routes/leaves.js';
import { harnessRouter } from './routes/harness/index.js';
import { personasRouter } from './routes/personas.js';
import { personaOptionsRouter } from './routes/persona-options.js';
import { authRouter } from './routes/auth.js';
import { koalaRouter } from './routes/koala.js';
import { personaChatRouter } from './routes/chat-pack.js';
import { chatRouter } from './routes/chat.js';
import { createAuth } from './middleware/auth.js';
import { projectsRouter } from './routes/projects.js';
import { meshRouter } from './routes/mesh.js';
import { clusterProvidersRouter } from './routes/cluster-providers.js';
import { providersToSeed } from './lib/cluster-providers.js';
import { vpsCatalogRouter } from './routes/vps-catalog.js';
import { adminRouter } from './routes/admin.js';
import { modelEndpointsRouter } from './routes/model-endpoints.js';
import { modelsRouter } from './routes/models.js';
import { temporalRouter } from './routes/temporal.js';
import { workerRouter } from './routes/worker.js';
import { nginxRouter } from './routes/nginx.js';
import { logsRouter } from './routes/logs.js';
import { registryRouter } from './routes/registry.js';
import { modulesRouter } from './routes/modules.js';
import { appSchemasRouter } from './routes/app-schemas.js';
import { ownsProject, ownedBy } from './lib/ownership.js';
import { openSse, sendFrame, forwardChunk, endSse } from './lib/sse.js';
import { mockOAuthAllowed } from './lib/oauth-gate.js';
import { createDatabase } from './lib/db-interface.js';
import { migrateLegacyOwnership } from './lib/migrate-ownership.js';

// Service Imports
import { InfrastructureService } from './services/InfrastructureService.js';
import { ClusterService } from './services/ClusterService.js';
import { AppService } from './services/AppService.js';
import { RegistryService } from './services/RegistryService.js';
import { GitModuleService } from './services/GitModuleService.js';
import { BuilderService } from './services/BuilderService.js';
import { AppExposureService } from './services/AppExposureService.js';
import type { ClusterMetadata, DeploymentMetadata, InviteMetadata, UserMetadata } from './lib/types.js';
import { validateAppSettings } from './lib/app-settings-schema.js';
import { validateClusterName } from './lib/cluster-name.js';
import { APP_SETTINGS_SCHEMAS, NO_WEB_UI_APP_TYPES } from './lib/app-schemas.js';
import { VpsCatalogService } from './services/VpsCatalogService.js';
import { TemporalBridge } from './services/TemporalBridge.js';
import WorkerService from './services/WorkerService.js';
import { ClusterProxyService } from './services/ClusterProxyService.js';
import net from 'net';
import crypto from 'crypto';
import { spawn } from 'child_process';
import axios from 'axios';
import { signJWT, verifyJWT, hashPassword, verifyPassword } from './lib/auth.js';
import { AuthService } from './services/AuthService.js';
import { CredentialService } from './services/CredentialService.js';
import { GiteaService } from './services/GiteaService.js';
import { InfisicalService } from './services/InfisicalService.js';
import { ProjectRepoService } from './services/ProjectRepoService.js';
import { HeadscaleService } from './services/HeadscaleService.js';
import { ModelService } from './services/ModelService.js';
import type { CloudProvider } from './lib/types.js';
import { getHfModelSize, getHfModelConfig, estimateKvCacheBytes, searchHfModels, getExl3ModelCollection, getHfModelBranches } from './lib/huggingface.js';
import { decryptValue, encryptValue } from './lib/crypto.js';
import { checkEndpointUrl, isMeshAddress } from './lib/endpoint-url-safety.js';
import { budgetForNewRoot } from './lib/budget-policy.js';
import { ContentScanner, UsageScanner } from './lib/token-usage.js';
import { AMBIENT_PROPOSAL_PROMPT, MAX_PROPOSALS_PER_REPLY, isChatMode, type ChatMode, PLAN_MODE_MAX_TOKENS, PLAN_SYSTEM_PROMPT, extractProposals, parseChatCommand, type LeafProposal } from './lib/plan-mode.js';
import { extractServiceName } from './lib/extraction.js';
import { buildOutboundMessages } from './lib/leaf-context.js';
import { isWorkspaceLanguage, imageForLanguage, WORKSPACE_IMAGES, DEFAULT_WORKSPACE_CPU, DEFAULT_WORKSPACE_MEMORY } from './lib/workspace-spec.js';
import { TOOL_DISCIPLINE_PROMPT } from './lib/sampling.js';
import { estimatePromptComplexity, FinishReasonScanner } from './lib/smart-token-controller.js';
import { ThoughtFeatureExtractor, predictFailure, updateModelProfile, ReasoningScanner } from './lib/thinking-classifier.js';
import { buildHarnessConfig } from './lib/harness-config.js';
import { buildModelRequest } from './lib/model-request.js';
import { planHostMemory, parseQuantity } from './lib/host-memory-plan.js';
import { TABBYAPI_DEFAULT_MAX_SEQ_LEN } from './lib/app-env.js';
import type { HarnessConfig } from '@koala/harness-types';
import {
  buildTaskAuthorPrompt, buildTaskChatPrompt, extractTaskProposals, extractTaskRevision, stripTaskBlock,
  AUTHORING_SAMPLING, AUTHORING_MAX_TOKENS,
  normaliseTasks,
} from './lib/experiment-authoring.js';
import { AuthoringService, acceptedTasks } from './services/AuthoringService.js';
import { WorkbenchService } from './services/WorkbenchService.js';
import { buildPromotion, supersede, revertTo, withOverrides } from './lib/harness-profile.js';
import { buildConfigExport, parseConfigExport } from './lib/config-export.js';
import { validateOverrides, loopKeys } from './lib/tunables.js';
import { runLeafTool as runLeafToolShared } from './lib/leaf-tool-runner.js';
import { newProposals, suspectedDuplicates, duplicateNotice, resolvePersonaNamed } from './lib/proposal-merge.js';
import { inheritedAcceptance } from './lib/acceptance-inherit.js';
import { specsToSeed, type AppSpec } from './lib/app-spec.js';
import { PERSONA_SEEDS } from './lib/persona-seeds.js';
import { validateSpec, explainSpecProblems } from './lib/app-spec-validate.js';
import { hollowChecks, explainHollow } from './lib/acceptance-validation.js';
import type { AcceptanceCheck } from './lib/acceptance.js';
import { chatMcpFor, NO_CHAT_MCP } from './lib/chat-mcp.js';
import {
  titleFrom, enabledForSession, MAX_TOOL_CALL_ARGS, MAX_TOOL_CALL_DIGEST, MAX_TOOL_CALLS_PER_MESSAGE,
  type Conversation, type ProposedTree, type ConversationToolCall,
} from './lib/conversations.js';
import { koalaSeed, isChatOnly, buildKoalaPrompt, KOALA_TEMPERATURE, KOALA_PROMPT } from './lib/koala-persona.js';
import { seedTools } from './lib/tool-seeds.js';
import { seedBindingTypes } from './lib/binding-type-seeds.js';
import { KOALA_TOOLS } from './lib/koala-tools.js';
import { runKoalaTool } from './lib/koala-tool-runner.js';
import { toLoopTools, routeCall } from './lib/mcp-tools.js';

import { claimService, claimNotice } from './lib/service-claim.js';
import { wantsMcp } from './lib/agent-run.js';
import { McpRegistryService } from './services/McpRegistryService.js';
import { resolveMcpProbeUrl } from './lib/mcp-probe-url.js';
import { preferUsable } from './lib/mcp-registry.js';
import { acceptLeaf } from './lib/accept-leaf.js';
import { droppedCount } from './lib/leaf-trace.js';
import { rollup, changedSince, columnFor } from './lib/tree-board.js';
import { fittedMaxTokens, MIN_TURN_TOKENS } from './lib/sampling.js';
import { needsHandoff, withHandoff, historyForPrompt, trimKoalaThread } from './lib/koala-context.js';
import { canRecheck, recheckVerdict, statusAfterRecheck } from './lib/leaf-recheck.js';
import { webhookUrlFor } from './lib/project-shipping.js';
import { buildReviewPrompt } from './lib/failure-review.js';
import { describeSandbox } from './lib/workspace-spec.js';
import { personaWorkspace } from './lib/persona-scope.js';
import { reviewBatch, DEFAULT_POLICY, type AutoAcceptPolicy } from './lib/auto-accept.js';
import { SearchCorpusActivity } from './activities/CrawlActivity.js';
import { resolveWebTools } from './lib/web-tools-resolver.js';
import { usablePaths } from './lib/leaf-artifacts.js';
import { normaliseLeafInput } from './lib/leaf-input.js';
import { rollupProjectStatus, deploymentForProject } from './lib/project-status.js';
import { summariseDelivery } from './lib/branch-delivery.js';
import { unassignedLeaves, buildAssignmentPrompt, buildUnassignedNotice, MAX_ASSIGNMENT_ROUNDS } from './lib/persona-assignment.js';
import { normaliseTreeInput, withProject, type Tree } from './lib/trees.js';
import { seedTreeTypes, validateTreeType, resolveTreeType } from './lib/tree-types.js';
import { reviewPlan, planNotice } from './lib/plan-review.js';
import { usableAcceptancePlan } from './lib/acceptance.js';
import { withNotice } from './lib/branch-notice.js';
import { resolveConfig, validatePersona, validateScope, type Persona } from './lib/personas.js';
import { ExperimentService } from './services/ExperimentService.js';
import {
  expandAxes, validateExperiment, plannedRuns, experimentTasks, taskIdOf, summariseExperiment, normaliseExperiment, latestResults,
  MAX_REPEATS, MAX_TASK_CHARS, MAX_TASKS, MAX_TASK_FILES, MAX_TASK_FILE_CHARS,
  type Experiment, type ExperimentTask,
} from './lib/experiments.js';
import { EXTRACTION_SCHEMA, EXTRACTION_SYSTEM_PROMPT, EXTRACTION_TEMPLATE_VARS, buildExtractionPrompt, parseExtractionResult } from './lib/extraction.js';
import { SANDBOX_TOOLS, MAX_AGENT_STEPS, trimConversation } from './lib/sandbox-tools.js';
import { LEAF_TOOLS, MAX_TOOL_ROUNDS, ToolCallScanner, type ToolCall, detailLeaf, parseToolArguments, summariseLeaf } from './lib/leaf-tools.js';
import { deriveBranchTitle, trimTranscript, type Branch, type BranchMessage, LEAF_COLUMNS, isLeafColumn, aggregateUsage, budgetExceeded, canAddChild, childrenOf, deriveLeafStatus, rootLeaf, subtreeOf, blockedBy, wouldCycle, type Leaf } from './lib/leaves.js';
import { generateSshKeypair } from './lib/ssh-keypair.js';
import { getToolRepository } from './lib/tool-repository.js';
import type { SearchOutcome } from './lib/web-tools.js';
import { unreachableMemory, type MemoryItem } from './lib/memory-store.js';

dotenv.config();

function startHostTunnel(port = 8000) {
  const server = net.createServer((socket) => {
    const child = spawn('docker', ['exec', '-i', 'provisioner-nginx', 'nc', '127.0.0.1', '80']);

    socket.pipe(child.stdin);
    child.stdout.pipe(socket);

    socket.on('error', () => child.kill());
    child.on('error', () => socket.destroy());
    socket.on('close', () => child.kill());
    child.on('close', () => socket.destroy());
  });

  server.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`ℹ️  Host tunnel port ${port} is already bound — reusing existing tunnel.`);
      return;
    }
    console.error(`Host tunnel server error: ${err.message}`);
  });

  server.listen(port, '::', () => {
    console.log(`🚀 Host Tunnel Server active on http://[::]:${port}`);
  });
}

const DEFAULT_LOG_LEVEL = 50;

/**
 * APPLICATION BOOTSTRAP
 *
 * The side-channel `TemporalBridge` is used by mutating API routes to route
 * through the long-lived Temporal workflow persistence engine.  All other
 * reads stay on the Local DB so they don't block until the workflow ends.
 */
export async function bootstrap(): Promise<{ app: express.Application; io: SocketServer; temporalBridge?: TemporalBridge }> {
  const app = express();
  const httpServer = createServer(app);
  const port = process.env.PORT || 3001;

  /**
   * Public origin this server is reached at, e.g. https://app.nowrinkles.dev.
   *
   * OAuth redirect URIs were hardcoded to http://localhost:3001, which cannot work once deployed:
   * the provider redirects the user's BROWSER there, and both Google and GitHub reject a
   * redirect_uri that does not exactly match what is registered.
   */
  const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, '');

  /**
   * Where the browser-facing UI lives — every post-auth redirect target.
   *
   * In production the backend serves the built frontend itself (bootstrap.sh runs `npm run build`
   * for exactly that reason), so this is the same origin as PUBLIC_URL. In dev the UI is Vite on
   * :5173 while the API is :3001, which is why these ever differed. Nine redirects were hardcoded
   * to localhost:5173, so on a deployed host OAuth would set a valid session cookie and then bounce
   * the user to a machine that isn't theirs.
   */
  const APP_URL = (process.env.APP_URL || process.env.PUBLIC_URL || 'http://localhost:5173').replace(/\/$/, '');

  /**
   * Origins allowed to make credentialed requests. Shared by the Express CORS policy and the
   * Socket.IO handshake — the socket carries the same session cookie, so a looser rule here would
   * hand back over WebSocket exactly what CORS refuses over HTTP.
   */
  const corsAllowed = new Set([PUBLIC_URL, APP_URL]);
  const originAllowed = (origin: string | undefined): boolean =>
    // No Origin header at all: same-origin navigations, curl, server-to-server. Not a cross-site
    // request, so there is nothing for CORS to protect against.
    !origin || process.env.NODE_ENV !== 'production' || corsAllowed.has(origin.replace(/\/$/, ''));

  // Socket.IO needs credentials:true for the browser to send the session cookie the handshake
  // below authenticates against, and `origin: '*'` is invalid in combination with it.
  const io = new SocketServer(httpServer, {
    cors: {
      origin: (origin, cb) => cb(null, originAllowed(origin)),
      credentials: true,
    },
  });

  // ── 1. Initialize backend ────────────────────────────────────────────────
  const db = createDatabase();
  await db.init();
  await migrateLegacyOwnership(db);
  await seedTools(db);
  await seedBindingTypes(db);

  const JWT_SECRET = process.env.JWT_SECRET || 'provisioning-platform-secret-12345';
  const infraService = new InfrastructureService();
  const builderService = new BuilderService(db, infraService);
  const clusterService = new ClusterService(db, infraService, JWT_SECRET);
  const appService = new AppService(db, infraService, clusterService, builderService);
  const registryService = new RegistryService(db);
  const gitModuleService = new GitModuleService(db);
  const appExposureService = new AppExposureService(db, infraService, clusterService, io);
  const clusterProxyService = new ClusterProxyService();
  const giteaService = new GiteaService(infraService, JWT_SECRET, '/tmp/kubeconfig-provisioning-lunorica');
  await giteaService.ensureClusterSecret().catch((err: Error) =>
    console.warn(`[gitea] could not ensure cluster secret: ${err.message}`),
  );
  const infisicalService = new InfisicalService(
    infraService,
    JWT_SECRET,
    '/tmp/kubeconfig-provisioning-lunorica',
  );
  const projectRepoService = new ProjectRepoService(db, giteaService, JWT_SECRET);
  const headscaleService = new HeadscaleService(JWT_SECRET, process.env.HEADSCALE_URL || 'http://localhost:8080');
  const modelService = new ModelService(db, appService, clusterService, clusterProxyService, headscaleService, JWT_SECRET);

  /**
   * The model ids this caller may name, for validating a `choicesFrom` knob at write time.
   *
   * Resolved per request because one tenant's models are not another's. Returns undefined when the
   * list cannot be built, which tells `validateOverrides` to skip the check rather than refuse
   * everything — a model list that failed to load must not make the persona form unusable.
   */
  const modelIdsFor = async (userId: string): Promise<string[] | undefined> => {
    try {
      return (await modelService.list(userId)).map((m) => m.id);
    } catch {
      return undefined;
    }
  };

  // The search functions are hoisted declarations, so passing them here — far above where they are
  // written — is safe. They reach the research SUB-AGENT only; the planner itself still has none.
  const experimentService = new ExperimentService(
    db, modelService, undefined, io, executeWebSearch, executeFetchWebPage,
  );
  const authoringService = new AuthoringService();
  const workbenchService = new WorkbenchService();

  // Pods whose session this process has no memory of — a restart empties the map and leaves them
  // running. Asks the cluster, which is the only question that survives a restart.
  workbenchService.sweepOrphans()
    .then((ids) => ids.length && console.log(`[bootstrap] Swept ${ids.length} orphaned workbench pod(s)`))
    .catch((err: any) => console.warn(`[bootstrap] Workbench sweep failed: ${err.message}`));

  // An experiment's "running" flag lives in process memory, so a restart mid-run leaves the record
  // claiming to be running with nothing driving it — a spinner that never resolves and no way to
  // start it again. Cleared here, before any route can serve that state.
  experimentService.reconcileInterrupted()
    .then((n) => n && console.log(`[bootstrap] Closed out ${n} experiment(s) interrupted by a restart`))
    .catch((err: any) => console.warn(`[bootstrap] Experiment reconcile failed: ${err.message}`));

  // Best-effort background check — see ClusterService.ensureSystemClusterGpuReady for why this
  // can't just be a side effect of the normal provisioning flow. Never blocks startup.
  clusterService.ensureSystemClusterGpuReady().catch((err: any) =>
    console.warn(`[bootstrap] System cluster GPU readiness check failed: ${err.message}`)
  );

  // ── 2. Temporal bridge (HTTP only → sketch → poll DB) ────────────────────
  const temporalBridge = new TemporalBridge(db, io, JWT_SECRET, clusterService, headscaleService);
  clusterService.setTemporalBridge(temporalBridge);
  appService.setTemporalBridge(temporalBridge);
  try {
    await temporalBridge.start();
    await temporalBridge.startActiveWorkflowRecovery();
  } catch (e: any) {
    // If Temporal is not reachable, serve the same UI with normal polling
    console.warn(`⚠️ Temporal TS bridge not available. Routes will fall back to Local DB.`, e.message);
  }

  const authService = new AuthService(db);
  // Reflecting any origin with credentials:true means any website a signed-in user visits can call
  // this API with their session cookie and read the response. sameSite:'lax' on the cookie is what
  // holds that back today, so this was one cookie flag away from being an account takeover —
  // fine on a dev box where the UI is a different port, not on a deployed host. In production the
  // frontend is served from this same origin, so an allowlist costs nothing.
  app.use(cors({
    origin: (origin, callback) => callback(null, originAllowed(origin)),
    credentials: true,
  }));

  // Registered before the global express.json() (and outside the /api prefix, so it never
  // passes through requireAuth below) — needs the *raw* request body to verify Gitea's
  // HMAC-SHA256 signature; the global json() parser would consume it first otherwise. Gitea
  // calls this unauthenticated, so signature verification is the only gate.
  app.post('/webhooks/gitea/:projectId', express.raw({ type: 'application/json' }), async (req, res) => {
    try {
      const projects = await db.getProjects();
      const project = projects.find((p: any) => p.id === req.params.projectId);
      if (!project) return res.status(404).json({ error: 'Unknown project' });
      if (!project.webhookSecretEnc) return res.status(500).json({ error: 'Project has no webhook secret configured' });

      const secret = decryptValue(project.webhookSecretEnc, JWT_SECRET);
      const rawBody = req.body as Buffer;
      if (!giteaService.verifyWebhookSignature(rawBody, req.header('X-Gitea-Signature'), secret)) {
        return res.status(401).json({ error: 'Invalid webhook signature' });
      }

      const payload = JSON.parse(rawBody.toString('utf8'));
      if (!payload.ref || !payload.after) return res.status(200).json({ status: 'ignored', reason: 'not a push event' });

      const ref = String(payload.ref).replace('refs/heads/', '');

      /**
       * Only the default branch builds.
       *
       * Every leaf pushes `koala/<leafId>` BEFORE its verification has run, and this filtered
       * nothing — so each leaf triggered a full image build from unverified work on a side branch,
       * and `autoDeployOnBuild` then promoted whatever came out of it. On the last run that was
       * most of the pipeline traffic.
       *
       * A side branch is work in progress by definition. Building it is at best wasted, and at
       * worst it deploys code that the verification about to run would have rejected.
       *
       * Taken from the payload's own repository rather than assumed to be `main`: a repository that
       * uses `master` or `trunk` would otherwise build nothing at all, silently.
       */
      const defaultBranch = String(payload.repository?.default_branch ?? 'main');
      if (ref !== defaultBranch) {
        return res.status(200).json({ status: 'ignored', reason: `not the default branch (${ref} != ${defaultBranch})` });
      }

      res.status(202).json({ status: 'accepted' });
      // Builds run in the background — Gitea has its own webhook-delivery timeout, don't block it.
      temporalBridge.runPipeline(project, payload.after, ref).catch((err: any) =>
        console.error(`[webhook] Failed to start pipeline run for project ${project.id}: ${err.message}`)
      );
    } catch (err: any) {
      console.error(`[webhook] Gitea webhook error: ${err.message}`);
      res.status(500).json({ error: 'Internal error processing webhook' });
    }
  });

  app.use(express.json());
  const credentialService = new CredentialService(db, JWT_SECRET);
  const vpsCatalogService = new VpsCatalogService(db, JWT_SECRET);

  /**
   * The auth guards, over this db and this secret.
   *
   * `requireAuth` and the Socket.IO handshake below both come from here on purpose — they must
   * accept exactly the same credential, and sharing `userFromSessionCookie` makes that structural.
   */
  const auth = createAuth({ db, jwtSecret: JWT_SECRET, publicUrl: PUBLIC_URL });
  const { requireAdmin, userFromSessionCookie } = auth;

  app.use('/api', auth.requireAuth);

  // ── 3. SOCKET.IO ORCHESTRATION ───────────────────────────────────────────

  /**
   * Socket.IO used to have no auth of any kind — no `io.use(...)`, unlike every /api route's
   * requireAuth. Any connected socket could `join-room` with a guessed resource id and receive
   * another tenant's live provisioning logs, or `tail-pod` their way into pod output on someone
   * else's cluster. Single-tenant that was invisible; invite-only multi-tenant it is a cross-tenant
   * leak of exactly the material most likely to contain secrets.
   *
   * The handshake takes the same session cookie as the HTTP API, so a socket can never be more
   * privileged than the browser that opened it.
   */
  io.use(async (socket, next) => {
    if (process.env.IS_E2E === 'true') {
      const users = await db.getUsers();
      socket.data.user = users[0] || { id: 'test-user-id', email: 'test@example.com' };
      return next();
    }
    try {
      const user = await userFromSessionCookie(socket.handshake.headers.cookie);
      if (!user) return next(new Error('Unauthorized'));
      socket.data.user = user;
      next();
    } catch {
      next(new Error('Unauthorized'));
    }
  });

  /**
   * Resolves a room id to the resource behind it, but only if this user may see it.
   *
   * Returns undefined for both "no such id" and "not yours" — same reasoning as
   * ClusterService.getById, which deliberately conflates the two so the socket cannot be used to
   * probe which resource ids exist on the platform.
   */
  async function authorizeRoom(user: UserMetadata | undefined, id: string): Promise<any | undefined> {
    if (!user) return undefined;
    const cluster = await clusterService.getById(id, user.id);
    if (cluster) return cluster;
    const deployment = await appService.getById(id, user.id);
    if (deployment) return deployment;
    // Pipeline runs hang off a project, and projects carry an ownerId as of this change; runs
    // inherit it. Legacy projects saved before that have none — those are visible to admins only,
    // rather than to everyone as before.
    const run = (await db.getPipelineRuns()).find((r: any) => r.id === id);
    if (run) {
      const project = (await db.getProjects()).find((p: any) => p.id === run.projectId);
      const owned = ownsProject(project, user);
      if (owned && run.logFile) return { ...run, lastLogPath: run.logFile };
    }
    return undefined;
  }

  io.on('connection', (socket) => {
    const socketTails = new Map<string, any>();

    socket.on('join-room', async (id) => {
      // Authorize BEFORE joining. The join is what makes the socket a recipient of everything
      // broadcast to that room — emitted progress, status and log lines — so joining first and
      // checking afterwards would leak regardless of what the check then decided.
      const resource = await authorizeRoom(socket.data.user, id);
      if (!resource) {
        socket.emit('room-denied', { id });
        return;
      }
      socket.join(id);

      const existing = socketTails.get(id);
      if (existing) {
        existing.kill();
        socketTails.delete(id);
      }

      if (resource.lastLogPath) {
        try {
          await fs.access(resource.lastLogPath);
        } catch {
          await fs.mkdir(path.dirname(resource.lastLogPath), { recursive: true }).catch(() => {});
          await fs.writeFile(resource.lastLogPath, '').catch(() => {});
        }

        /**
         * Recent history, not follow-only.
         *
         * `-n 0` meant joining a room showed nothing that had already been written — a log opened
         * after a step finished stayed blank, and the only thing that ever filled it was
         * react-query refetching the HTTP copy on window focus. Reported exactly that way: the log
         * appeared after switching browser tabs and coming back.
         *
         * The client clears its buffer on join, so replaying history cannot double up the way it
         * did for pod tails before they started clearing.
         */
        const tail = spawn('tail', ['-n', String(LOG_TAIL_LINES), '-f', resource.lastLogPath]);
        socketTails.set(id, tail);

        tail.stdout.on('data', (data) => {
          socket.emit('log', data.toString());
        });

        tail.stderr.on('data', (data) => {
          socket.emit('log', data.toString());
        });

        tail.on('error', (err) => {
          console.warn(`[log-tail] ${resource.lastLogPath}: ${err.message}`);
          socketTails.delete(id);
        });

        tail.on('close', () => {
          socketTails.delete(id);
        });
      }
    });

    socket.on('join-kube-room', async (id) => {
      if (!(await authorizeRoom(socket.data.user, id))) {
        socket.emit('room-denied', { id });
        return;
      }
      socket.join(`${id}-kube`);
    });
    socket.on('tail-pod', async ({ resourceId, podName, namespace }) => {
      const user = socket.data.user as UserMetadata | undefined;
      if (!user) return;
      // Ownership-scoped lookup, not the raw db.getDeployments() this used to do: streamLogs
      // shells out to `kubectl logs` with the caller's pod name against a kubeconfig chosen here,
      // so an unowned deployment id meant reading pod output on someone else's cluster.
      const dep = await appService.getById(resourceId, user.id);
      // Bail rather than fall through. Previously an unresolvable deployment left kubeconfigPath
      // undefined and still ran `kubectl logs` — against the host's default context, which is the
      // management cluster. That is a worse leak than the one being closed, not a graceful
      // degradation.
      if (!dep) {
        socket.emit('room-denied', { id: resourceId });
        return;
      }
      const cluster = dep.clusterId === 'provisioning-lunorica'
        ? await clusterService.getSystemClusterEntry()
        : await clusterService.getById(dep.clusterId, user.id);
      if (!cluster) {
        socket.emit('room-denied', { id: resourceId });
        return;
      }
      let context: string | undefined;
      const isMock = clusterService.isMockCloud(cluster);
      const physicalName = clusterService.getPhysicalClusterName(cluster);
      if (cluster.provider === 'k3d' || isMock) context = `k3d-${physicalName}`;
      const kubeconfigPath = await clusterService.getKubeconfigPath(cluster);
      const args = ['logs', '-n', namespace || 'default', podName, '--all-containers=true', '--tail=100', '-f'];
      if (context) args.push('--context', context);
      infraService.streamLogs(resourceId, args, io, `${resourceId}-kube`, kubeconfigPath);
    });

    socket.on('leave-room', (id) => {
      socket.leave(id);
      const tail = socketTails.get(id);
      if (tail) {
        tail.kill();
        socketTails.delete(id);
      }
    });

    socket.on('leave-kube-room', (id) => { socket.leave(`${id}-kube`); infraService.stopStream(id); });

    socket.on('disconnect', () => {
      for (const tail of socketTails.values()) {
        tail.kill();
      }
      socketTails.clear();
    });
  });

  // ── 4. ROUTES ────────────────────────────────────────────────────────────

  /** ── AUTHENTICATION ── */

  /**
   * Session cookie flags.
   *
   * `secure` was hardcoded false, which over HTTPS means the session travels in cleartext to any
   * attacker who can force one plain-http request. It has to stay false in dev, where there is no
   * TLS and a secure cookie would simply never be stored — hence keying it off the origin scheme
   * rather than a hardcoded value.
   *
   * `sameSite: 'lax'` is what the browser already defaults to; stating it makes the CORS policy
   * below (which reflects any origin) safe to reason about instead of relying on a default.
   */
  app.use('/api/auth', authRouter({
    db, authService, auth, jwtSecret: JWT_SECRET, publicUrl: PUBLIC_URL, appUrl: APP_URL,
  }));







  /**
   * Whether the zero-setup mock OAuth flow may run.
   *
   * The mock exists so a local dev box can sign in without registering an OAuth app. It logs in as
   * a fixed identity with NO credential of any kind — and since the first user to exist becomes
   * admin, that identity is the admin account.
   *
   * It must therefore never be reachable on a deployed host. Two things made it reachable:
   *
   *  1. `/api/auth/<provider>` redirected to the callback with a magic code whenever the client id
   *     was unset — so an unconfigured production host handed admin to anyone who visited a URL.
   *  2. Worse, the callback's own guard was `code !== 'mock-<provider>-code'`, which is attacker
   *     controlled. Requesting the callback directly with that code skipped the real token
   *     exchange and logged you in as the mock user EVEN WITH OAUTH FULLY CONFIGURED. Setting up
   *     Google did not close the hole.
   *
   * Gating on NODE_ENV rather than on whether a client id happens to be set means a production
   * host with missing configuration fails closed — no login — instead of failing open.
   */






  /** ── ADMIN — invites ── */



  /** ── MESH — Headscale-backed remote cluster target connectivity (distributed-systems plan Phase 1) ── */

  /**
   * Confirms a hostname belongs to a real, publicly exposed deployment.
   *
   * Deliberately mounted OUTSIDE /api so it needs no session: Caddy calls it, not a browser, and
   * requireAuth is mounted at `/api` (index.ts:221) so it never sees this path. Moving this route
   * under /api would silently break certificate issuance with a 401.
   *
   * Not needed for the current configuration, where AppExposureService writes an explicit site
   * block per app and an unlisted name simply gets no certificate. It exists for the moment custom
   * domains arrive and Caddy has to serve names it did not know at config time: on-demand TLS
   * without a gate like this lets anyone point DNS at the root node and burn Let's Encrypt's
   * 50-per-week-per-registered-domain limit.
   */
  app.get('/ingress/verify', async (req, res) => {
    const domain = String(req.query.domain ?? '');
    if (!domain) return res.status(400).send('domain required');
    const deployments = await db.getDeployments();
    const owned = deployments.some((d) => d.isExposedPublicly && d.publicHostname === domain);
    // Caddy treats any non-2xx as "do not issue".
    return owned ? res.status(200).send('ok') : res.status(404).send('unknown host');
  });





  /** ── CREDENTIALS ── */



  /**
   * ── CREDENTIALS + BACKUP ──
   *
   * The first two routers. Everything they replace — eight handlers, four copies of the provider
   * check and eight hand-written 500s — now lives in `routes/credentials.ts` and `routes/backup.ts`
   * where it can be tested without booting this file. See `routes/test-harness.ts`.
   *
   * Mounted in the position the routes previously occupied. Order is not load-bearing between these
   * two prefixes, but keeping it means the diff says what it did and nothing else.
   */
  app.use('/api/credentials', credentialsRouter({
    credentialService,
    publicUrl: PUBLIC_URL,
    appUrl: APP_URL,
  }));
  app.use('/api/backup', backupRouter({ repoRoot: path.join(__dirname, '../../..') }));

  /**
   * ── CLUSTERS ──
   *
   * Including the five dashboard proxy routes, which had been registered 300 lines away between
   * the GitHub and Google OAuth callbacks — not wrongly, just wherever the person adding them
   * happened to be, because there was nowhere for them to go.
   */
  app.use('/api/clusters', clustersRouter({
    clusterService, appService, clusterProxyService, infraService,
    temporalBridge, db, io, giteaService, jwtSecret: JWT_SECRET,
  }));
  /**
   * ── DEPLOYMENTS ──
   *
   * Thirteen routes, four of which had been registered near the bottom of this file — `/modules`,
   * `/storage`, `/resource-plan` and `/config`, past the board and the chat handlers, 3,900 lines
   * from the other nine.
   */
  app.use('/api/deployments', deploymentsRouter({
    appService, clusterService, appExposureService, infraService, temporalBridge, db, io,
  }));
  /** ── PROJECTS (CI/CD: sibling repos hosted on the self-hosted Gitea) ── */

  /**
   * Projects were the one resource with no ownership model at all — every user saw every project,
   * and the socket rooms for their pipeline runs inherited that. Projects created from here on
   * carry an ownerId; projects that predate it have none and stay admin-only rather than staying
   * visible to everyone (this instance's only projects are the admin's own, so nothing is
   * stranded — on a shared instance that would deserve a migration instead).
   */

  const getOwnedProject = async (id: string, user: any): Promise<any | undefined> => {
    const project = (await db.getProjects()).find((p: any) => p.id === id);
    return project && ownsProject(project, user) ? project : undefined;
  };





  /**
   * The agent's web access, resolved per call — see lib/web-tools.ts and lib/web-tools-resolver.ts.
   *
   * Both implementations used to live here inline: a regex over DuckDuckGo's HTML, and a tag
   * stripper. They are still the floor, and still run when nothing better is deployed; what has
   * changed is that a SearXNG or Crawl4AI deployment now gets used automatically when one exists.
   *
   * Resolved per call rather than once at bootstrap because the deployment can appear, move or go
   * away while the process is up, and a service cached at boot is one the user cannot fix without
   * restarting the backend. The port-forward underneath is cached, so the repeat cost is a database
   * read.
   */
  async function webTools() {
    return resolveWebTools({
      db,
      ensurePortForward: (clusterId, serviceKey, kubeconfigPath, target) =>
        clusterProxyService.ensurePortForward(clusterId, serviceKey, kubeconfigPath, target),
      kubeconfigFor: async (clusterId: string) => {
        // getByIdUnscoped, NOT db.getClusters(): the management cluster is SYNTHESIZED by
        // ClusterService and never written to the database, so a direct DB read finds nothing for
        // the one cluster almost everything is deployed to. Unscoped is right here — this runs on
        // the agent's tool path, which has already resolved ownership of the deployment itself.
        const cluster = await clusterService.getByIdUnscoped(clusterId);
        return cluster ? clusterService.getKubeconfigPath(cluster) : undefined;
      },
    });
  }

  /**
   * Returns the OUTCOME, not just the hits.
   *
   * Dropping to a bare array here is what erased the difference between "nothing matched" and
   * "nothing looked" for every caller downstream — see `SearchOutcome` in lib/web-tools.ts.
   */
  async function executeWebSearch(query: string): Promise<SearchOutcome> {
    return (await webTools()).search(query);
  }

  async function executeFetchWebPage(url: string): Promise<string> {
    return (await webTools()).fetchPage(url);
  }

  /**
   * Runs a tool the model asked for, against this user's own data.
   *
   * Every lookup is ownership-scoped: a tool call is model output, so an id in it is untrusted
   * input exactly like one from a URL. Errors are returned as tool RESULTS rather than thrown —
   * the model can recover from "no such leaf" if it is told, and cannot if the request dies.
   */
  /**
   * Whether a tool result is a refusal rather than a completed action.
   *
   * Every handler reports failure as `{ error }` in its JSON result, so this reads the same shape
   * they all write. Unparseable output is treated as a refusal: the callers use this to decide
   * whether something was really created, and guessing "yes" there is the expensive direction.
   */
  function toolRefused(result: string): boolean {
    try {
      return Boolean(JSON.parse(result)?.error);
    } catch {
      return true;
    }
  }

  /** Owner-filtered here, never by id alone: `getPersonas` returns every user's. */
  const ownedPersonas = async (userId: string): Promise<Persona[]> =>
    (await db.getPersonas()).filter((p) => p.ownerId === userId);

  /**
   * Delegates to the shared runner so the route and a headless experiment execute the same code.
   *
   * The body used to live here, which meant anything measuring how well a model decomposes work
   * would have had to reimplement it — and a reimplementation is what produced the first planning
   * experiment's null result.
   */
  async function runLeafTool(userId: string, branchId: string, call: { name: string; arguments: string }): Promise<string> {
    return runLeafToolShared(
      {
        db,
        userId,
        branchId,
        webSearch: executeWebSearch,
        fetchWebPage: executeFetchWebPage,
        projects: projectRepoService,
        /**
         * Ingestion, driven as a Temporal workflow rather than inline.
         *
         * Present only when Temporal is reachable — the platform runs without it, and a tool that
         * appeared to start a crawl and silently did nothing would be worse than one that says it
         * is unavailable.
         */
        ...(temporalBridge
          ? {
              ingest: {
                start: (a: Parameters<typeof temporalBridge.startIngest>[0]) => temporalBridge.startIngest(a),
                status: (id: string) => temporalBridge.ingestStatus(id),
                search: (a: { ownerId: string; query: string; ingestId?: string }) => SearchCorpusActivity(a),
              },
            }
          : {}),
        /**
         * The same registry the executor builds, constructed per call and scoped to this user.
         *
         * Per call because the ownerId is part of the construction — a registry made once at
         * bootstrap would have to be told whose deployments to show on every use, which is exactly
         * the shape that leaked across tenants the last time.
         */
        mcpRegistry: new McpRegistryService(db, userId, (name: string) => resolveMcpProbeUrl(name)),
      },
      call,
    );
  }

  /** ── HARNESS — what the agent is configured to do, and experiments against it ── */



  /**
   * The live configuration, assembled from the modules the running code uses.
   *
   * Never a hand-written copy: a stale number here would have someone tune a sampler, read the old
   * value, and conclude the change did nothing.
   */
  app.get('/api/harness/config', async (req, res) => {
    // The caller's adopted defaults, folded in — otherwise this page describes a configuration
    // nobody is running.
    const userId = (req as any).user.id;
    const profile = await db.getHarnessProfile(userId);

    /**
     * The model APIs this caller can reach, so the picker offers what exists instead of taking a
     * free-text id that only ever resolves to "Model X not found".
     *
     * Failure here is not failure of the page. Listing touches deployments and the cluster, and a
     * cluster being down should cost you the model dropdown, not every prompt and sampler setting
     * on the screen.
     */
    let models: HarnessConfig['models'] = [];
    try {
      models = (await modelService.list(userId)).map((m) => ({
        id: m.id,
        name: m.name,
        model: m.model,
        source: m.source,
        ...(m.kind ? { kind: m.kind } : {}),
      }));
    } catch (err: any) {
      console.warn('[harness] could not list models:', err?.message ?? err);
    }

    res.json(buildHarnessConfig(profile?.overrides ?? {}, models));
  });

  /** ── WORKBENCH — a live sandbox for writing a verify command against ── */





  /** ── AUTHORING — Koala proposes the suite, the sandbox proves the verify commands ── */



  /**
   * The configuration as a file you can commit.
   *
   * Makes git available without making it load-bearing: the running system keeps reading from the
   * database, and this is the artifact to review, share or restore. Carries suite DEFINITIONS and
   * adopted defaults — never results, which mean nothing on another machine.
   */
  app.get('/api/harness/export', async (req, res) => {
    const userId = (req as any).user.id;
    const mine = (await db.getExperiments()).filter((e) => e.ownerId === userId);
    res.json(buildConfigExport(mine, await db.getHarnessProfile(userId)));
  });

  /** Restores suites from an exported document. Definitions only — each side answers for itself. */
  app.post('/api/harness/import', async (req, res) => {
    const userId = (req as any).user.id;
    const parsed = parseConfigExport(req.body);
    if ('error' in parsed) return res.status(400).json({ error: parsed.error });

    const created: string[] = [];
    const failed: string[] = [];
    for (const suite of parsed.suites) {
      const now = new Date().toISOString();
      const draft: Experiment = {
        id: uuidv4(),
        ownerId: userId,
        name: suite.name.slice(0, 120),
        tasks: normaliseTasks(suite.tasks),
        language: 'node',
        variants: suite.variants,
        repeats: Math.max(1, Math.min(MAX_REPEATS, suite.repeats)),
        status: 'draft',
        results: [],
        createdAt: now,
        updatedAt: now,
      };
      // Validated like anything else: an imported suite gets no exemption from the rules that stop
      // a malformed one burning GPU time.
      const invalid = validateExperiment(draft);
      if (invalid) { failed.push(`${suite.name}: ${invalid}`); continue; }
      await db.saveExperiment(draft);
      created.push(draft.name);
    }
    res.json({ created, failed, rejected: parsed.rejected });
  });

  /** ── PROMOTED DEFAULTS — a winning configuration adopted as the harness's own ── */


  /** ── PERSONAS — named configurations you pick, rather than the one everybody gets ── */




















  // ── TOOL REPOSITORY ──




  // ── MEMORY BANK ──







  /**
   * Ownership filters, from `lib/ownership.ts`. These were hand-written closures — one per
   * collection, each a line that could be forgotten on the next one.
   */
  const ownedBranches = async (userId: string) => ownedBy(await db.getBranches(), userId);
  const ownedLeaves = async (userId: string) => ownedBy(await db.getLeaves(), userId);
  const ownedTrees = async (userId: string) => ownedBy(await db.getTrees(), userId);

  /**
   * The built-in app specs exist in the database.
   *
   * Specs live in Mongo so they can be edited at runtime, which is the point — but a fresh
   * `git clone && npm run setup` starts with an empty one, and a platform that can deploy nothing
   * until somebody types a spec is not functional. The repo carries the seeds; the database is the
   * runtime source.
   *
   * Idempotent and conservative: `specsToSeed` adds what is missing, ships a changed default, and
   * leaves alone anything a person has edited. Failure is logged, never fatal — the platform still
   * has fifteen constructs and works without a single spec.
   */
  async function seedAppSpecs(): Promise<void> {
    try {
      const stored = await db.getAppSpecs();
      const pending = specsToSeed(stored);
      if (!pending.length) return;
      const now = new Date().toISOString();
      for (const spec of pending) {
        const existing = stored.find((s) => s.id === spec.id);
        await db.saveAppSpec({
          id: spec.id,
          spec,
          builtIn: true,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        });
      }
      console.log(`[app-specs] seeded ${pending.length} built-in spec(s): ${pending.map((s) => s.id).join(', ')}`);
    } catch (err: any) {
      console.warn(`[app-specs] could not seed built-in specs: ${err.message}`);
    }
  }
  await seedAppSpecs();

  /**
   * Cluster providers: the repo carries the built-ins (lib/cluster-providers.ts); the database is
   * the runtime source. Idempotent and conservative like seedAppSpecs — an edited or retired row is
   * left alone, only genuinely missing built-ins are added. Failure logged, never fatal.
   */
  async function seedClusterProviders(): Promise<void> {
    try {
      const stored = await db.getClusterProviders();
      const pending = providersToSeed(stored);
      if (!pending.length) return;
      for (const provider of pending) {
        await db.saveClusterProvider(provider);
      }
      console.log(`[cluster-providers] seeded ${pending.length}: ${pending.map((p) => p.value).join(', ')}`);
    } catch (err: any) {
      console.warn(`[cluster-providers] could not seed built-in providers: ${err.message}`);
    }
  }
  await seedClusterProviders();

  /** The host nginx config the editor reads and writes. */
  const NGINX_CONF_PATH = path.join(__dirname, '../data/nginx/nginx.conf');

  /** Manages the in-cluster worker pod. Constructed here rather than 1,700 lines below, where
   *  it used to sit for no reason beyond where its routes happened to be written. */
  const workerService = new WorkerService();

  /**
   * ── THE REMAINING RESOURCE ROUTES ──
   *
   * Thirteen prefixes. `/api/models` was the interesting one: its six routes were scattered across
   * 1,100 lines of this file, so they were extracted BY PREFIX rather than by contiguous block —
   * which is the only way a route that drifted from its neighbours comes home.
   *
   * `requireAdmin` stays per-route rather than being promoted to the admin router: it guards two
   * routes there and nothing else, and a router-level guard would silently start covering anything
   * added later.
   */
  app.use('/api/projects', projectsRouter({
    db, projectRepoService, appService, temporalBridge, getOwnedProject,
    giteaService, clusterService, infraService, jwtSecret: JWT_SECRET,
  }));
  app.use('/api/mesh', meshRouter({ headscaleService, db, jwtSecret: JWT_SECRET }));
  app.use('/api/cluster-providers', clusterProvidersRouter({ db }));
  app.use('/api/vps-catalog', vpsCatalogRouter({ vpsCatalogService }));
  app.use('/api/admin', adminRouter({ db, requireAdmin }));
  app.use('/api/model-endpoints', modelEndpointsRouter({
    modelService, db, headscaleService, jwtSecret: JWT_SECRET,
  }));
  app.use('/api/models', modelsRouter({ modelService, db, credentialService }));
  app.use('/api/temporal', temporalRouter({ temporalBridge }));
  app.use('/api/worker', workerRouter({ workerService }));
  app.use('/api/nginx', nginxRouter({ infraService, nginxConfPath: NGINX_CONF_PATH }));
  app.use('/api/logs', logsRouter({ db, clusterService, appService }));
  app.use('/api/registry', registryRouter({ registryService }));
  app.use('/api/modules', modulesRouter({ gitModuleService }));
  app.use('/api/app-schemas', appSchemasRouter({}));

  /**
   * ── THE HARNESS AND PERSONAS ──
   *
   * `/api/harness/*` was 34 routes on one `app` object. Six sub-resources, six routers, composed
   * in `routes/harness/index.ts` — so the one-router-per-prefix rule holds at the level a route
   * actually belongs to, rather than producing one 900-line file.
   *
   * `/api/harness/config`, `/export` and `/import` stay here: they read the whole harness rather
   * than any one resource, so there is no sub-prefix they belong under.
   */
  const ownedConversations = async (userId: string) =>
    (await db.getConversations()).filter((c) => c.ownerId === userId);

  /**
   * ── THE TWO CHAT ROUTES ──
   *
   * Separate routers because they speak DIFFERENT wire formats on purpose: `/api/chat` forwards the
   * provider's raw OpenAI frames byte-for-byte, `/api/koala/chat` uses its own
   * `{delta}`/`{reasoning}`/`{toolResult}` envelope. Merging them is a later, tested change.
   *
   * The shared helpers below are passed to both rather than duplicated — `toolRefused` in
   * particular decides when a round loop stops, and two copies is how the two loops quietly stop
   * agreeing about what a refusal is.
   */
  app.use('/api/koala', koalaRouter({
    db, modelService,
    projectRepoService,
    temporalBridge,
    infraService,
    infisicalService,
    jwtSecret: JWT_SECRET,
    ensureKoala, ensurePersonas, koalaServers,
    ownedConversations, executeWebSearch, executeFetchWebPage, toolRefused,
  }));

  /** The generic persona-pack chat: any registered pack -> a lived conversation on the unified wire. */
  app.use('/api/chat-pack', personaChatRouter({
    db, modelService,
    projectRepoService,
    temporalBridge,
    infraService,
    infisicalService,
    jwtSecret: JWT_SECRET,
    resolvePersona: async (userId, name) => {
      // 'Koala' resolves to the seeded chat-only persona; anything else by name, seeded on demand.
      if (name === 'Koala') return ensureKoala(userId);
      const mine = await ownedPersonas(userId);
      const found = mine.find((p) => p.name === name);
      return found ?? ensureKoala(userId);
    },
    serversFor: koalaServers,
    ownedConversations,
    webSearch: executeWebSearch,
    fetchWebPage: executeFetchWebPage,
    toolRefused,
  }));
  app.use('/api/chat', chatRouter({
    db, modelService, temporalBridge, projectRepoService,
    ownedPersonas, ownedBranches, ownedLeaves, ownedTrees, runLeafTool, toolRefused,
  }));

  app.use('/api/harness', harnessRouter({
    db, modelIdsFor, temporalBridge, experimentService, authoringService, workbenchService,
    modelService,
  }));
  app.use('/api/personas', personasRouter({ db, modelIdsFor, ensurePersonas }));
  app.use('/api/persona-options', personaOptionsRouter({ db, modelIdsFor }));

  /**
   * ── THE GROVE: TREE TYPES, TREES, BRANCHES ──
   *
   * Three prefixes, three routers. None of them gained a service: these routes read and write
   * records and call `lib/` for anything that thinks, so a service would be a class whose every
   * method was one `db` call with an ownership filter in front of it. The filter is `ownedBy` from
   * lib/ownership.ts — which is what the `ownedTrees`/`ownedBranches` closures here became.
   */
  app.use('/api/tree-types', treeTypesRouter({ db }));
  app.use('/api/binding-types', bindingTypesRouter({ db }));
  app.use('/api/trees', treesRouter({ db, temporalBridge }));
  app.use('/api/branches', branchesRouter({ db, temporalBridge }));
  /** ── GENERAL CHAT — Koala outside the tree structure (see lib/conversations.ts) ── */

  /**
   * Koala exists for this user, creating it if it does not.
   *
   * Create-if-absent rather than a migration or a seeding script: `scripts/seed-personas.ts` has a
   * hardcoded owner and no npm script, so personas were only ever seeded by hand for one account and
   * a new user has none. This runs on the path that needs it, works for old and new accounts alike,
   * and puts Koala back if someone deletes it — only its EXISTENCE is guaranteed, never its contents,
   * so an edited prompt survives.
   */
  /**
   * The user has the personas that do the work.
   *
   * `scripts/seed-personas.ts` had them inline with a hardcoded owner, so they were seeded by hand
   * for one account and a new user got none. That is not a cosmetic gap: a leaf with no persona has
   * no environment and `acceptLeaf` refuses it, so a fresh install could not accept a single piece
   * of work.
   *
   * ADDS only, never overwrites. Reverting someone's edited persona every time they open the app is
   * the failure the app-spec seeding avoids for the same reason — they fix it, restart, and find it
   * undone with nothing saying why. The script still overwrites, because that is how a developer
   * ships a change to a prompt.
   */
  async function ensurePersonas(userId: string): Promise<void> {
    try {
      const mine = await ownedPersonas(userId);
      const missing = PERSONA_SEEDS.filter((seed) => !mine.some((p) => p.name === seed.name));
      if (!missing.length) return;
      const now = new Date().toISOString();
      for (const seed of missing) {
        await db.savePersona({ id: uuidv4(), ownerId: userId, ...seed, createdAt: now, updatedAt: now } as Persona);
      }
      console.log(`[personas] seeded ${missing.length} for ${userId.slice(0, 8)}: ${missing.map((s) => s.name).join(', ')}`);
    } catch (err: any) {
      console.warn(`[personas] could not seed: ${err.message}`);
    }
  }

  async function ensureKoala(userId: string): Promise<Persona> {
    const mine = await ownedPersonas(userId);
    const found = mine.find((p) => isChatOnly(p));
    if (found) {
      let needsSave = false;
      if (found.overrides?.temperature === undefined) {
        found.overrides = { ...(found.overrides ?? {}), temperature: KOALA_TEMPERATURE };
        needsSave = true;
      }
      if (!found.systemPrompt || !found.systemPrompt.includes('Projects & Execution:')) {
        found.systemPrompt = KOALA_PROMPT;
        needsSave = true;
      }
      if (needsSave) {
        found.updatedAt = new Date().toISOString();
        await db.savePersona(found);
      }
      return found;
    }
    const now = new Date().toISOString();
    const created = {
      ...koalaSeed(), id: uuidv4(), ownerId: userId, createdAt: now, updatedAt: now,
    } as Persona;
    await db.savePersona(created);
    console.log(`[personas] created Koala persona for ${userId.slice(0, 8)}`);
    return created;
  }

  /** Everything deployed for this user, healthiest copy per name. Never throws: chat works without it. */
  async function koalaServers(userId: string) {
    try {
      const registry = new McpRegistryService(db, userId, (n: string) => resolveMcpProbeUrl(n));
      return preferUsable(await registry.listWithTools());
    } catch (err: any) {
      console.warn(`[koala] could not list services: ${err.message}`);
      return [];
    }
  }









  /** ── MODELS / CHAT — agent harness Phase A (~/.claude/plans/agent-harness.md) ── */








  /**
   * ── THE BOARD ──
   *
   * Ten routes and 455 lines, the largest single domain left in this file. Like trees and branches
   * it gained no service: it reads a record, asks `lib/leaves.ts` a question, and writes the answer
   * back. The one sequence that genuinely wanted a home — start a workflow, signal a parent, update
   * the board — already had one in `lib/accept-leaf.ts`, shared with the automatic path.
   */
  app.use('/api/leaves', leavesRouter({ db, temporalBridge, giteaService }));

  // available, e.g. an unusual repo name) — see DownloadModelActivity.ts for the shared file
  // -listing helper this also uses for the actual pre-download. Also estimates GPU VRAM (weight
  // shard + KV cache) for the requested context length/cache mode/GPU count, since that's a
  // separate concern from the download size and from the host-side shm/memory sizing tabbyapi.ts
  // does — see huggingface.ts's estimateKvCacheBytes for why this is informational, not a hard
  // validation gate (K8s' nvidia device plugin lets you request a GPU count, not a VRAM amount).

  // Backs the wizard's model picker for vLLM/TabbyAPI — an empty q still returns something
  // useful (top-downloaded results) rather than nothing, replacing what used to be a static
  // hardcoded list of 4-5 models baked into the frontend. TabbyAPI only runs EXL3 quants, so its
  // results come from turboderp's curated exl3-models collection instead of generic search —
  // see getExl3ModelCollection's own comment for why.

  // Lets the wizard show which bits-per-weight branches actually exist for a picked model —
  // see getHfModelBranches's own comment for why this is a separate lookup from the model
  // picker itself (EXL2/EXL3 quants split bpw variants across branches of one repo).

  /** ── NGINX config ── */




  /** ── TEMPORAL — monitoring ── */






  /** ── INIT ── */
  if (process.env.NODE_ENV !== 'test') {
    appExposureService.syncExposedApps().catch((e) => {
      const err = e instanceof Error ? e.message : String(e);
      console.error(`Failed to sync exposed apps to nginx: ${err}`);
    });
  }

  // ── WORKER ──





  // In production the frontend is a static build served from here, so Caddy has a single upstream
  // and the browser never makes a cross-origin request (which would need CORS and would break the
  // `session` cookie's SameSite default). In development Vite serves it on :5173 instead.
  //
  // Registered AFTER every /api route so it can never shadow one, and the SPA fallback explicitly
  // refuses /api paths — otherwise a typo'd endpoint would return index.html with a 200 instead of
  // a 404, which is a genuinely confusing thing to debug from the browser.
  if (process.env.NODE_ENV === 'production') {
    const distPath = path.resolve(__dirname, '../../frontend/dist');
    if (fsSync.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(distPath, 'index.html')));
      console.log(`📦 Serving the frontend from ${distPath}`);
    } else {
      console.warn(`⚠️  NODE_ENV=production but no frontend build at ${distPath} — run \`npm run build\`.`);
    }
  }

  if (process.env.NODE_ENV !== 'test' || process.env.IS_E2E === 'true') {
    const hostTunnelPort = process.env.IS_E2E === 'true' ? 8001 : 8000;
    startHostTunnel(hostTunnelPort);
    httpServer.on('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`❌ Port ${port} is already in use by another process. Run 'npm run clean-dev' or free port ${port}.`);
        process.exit(1);
      }
      console.error(`Provisioning Server Error: ${err.message}`);
      process.exit(1);
    });
    httpServer.listen(port, () => console.log(`🚀 Provisioning Server Active on http://localhost:${port}`));
  }

  const shutdown = () => { clusterProxyService.stopAll(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return { app, io, temporalBridge };
}

if (process.env.NODE_ENV !== 'test' || process.env.IS_E2E === 'true') {
  bootstrap().catch(console.error);
}

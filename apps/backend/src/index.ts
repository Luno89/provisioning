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
import { treesRouter } from './routes/trees.js';
import { branchesRouter } from './routes/branches.js';
import { leavesRouter } from './routes/leaves.js';
import { harnessRouter } from './routes/harness/index.js';
import { personasRouter } from './routes/personas.js';
import { personaOptionsRouter } from './routes/persona-options.js';
import { authRouter } from './routes/auth.js';
import { createAuth } from './middleware/auth.js';
import { projectsRouter } from './routes/projects.js';
import { meshRouter } from './routes/mesh.js';
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
import { koalaSeed, isChatOnly, buildKoalaPrompt, KOALA_TEMPERATURE } from './lib/koala-persona.js';
import { KOALA_TOOLS } from './lib/koala-tools.js';
import { runKoalaTool } from './lib/koala-tool-runner.js';
import { toLoopTools, routeCall } from './lib/mcp-tools.js';
/** Room for a turn that inspects, enables a service and then answers. */
const KOALA_MAX_TOKENS = 8000;
/**
 * Ceiling on one remote tool's answer.
 *
 * A service returns whatever it likes, and an unbounded answer can leave `fittedMaxTokens` nothing
 * for the reply — a turn ending on `finish_reason: length` having said nothing.
 *
 * But trimming too hard is worse than not trimming. At 4000 the GitHub repository payload was cut
 * before `stargazers_count`, and the model — having noticed, and said so — answered from memory
 * instead: "well over 160,000 stars". A truncated tool result does not read as missing data to a
 * model, it reads as permission to fall back on what it already believes, and the user cannot tell
 * the difference.
 *
 * 12000 fits that payload whole against a measured prompt of ~6500 characters with the budget
 * untouched. The ceiling is for a runaway response, not for ordinary ones.
 */
const MAX_REMOTE_RESULT = 12000;
/**
 * Tool rounds per turn.
 *
 * Six was not enough, measured: a single question — "what services do you have, and look up
 * microsoft/vscode" — spent rounds on listing, enabling, and re-reading, and hit the cap with the
 * reply mid-sentence: "Now let me look up the microsoft/vscode repository for you:". The work was
 * right and the budget ended first.
 *
 * The sequence this has to fit is list → enable → call → answer, and a reasoning model spends a
 * round thinking between each. Twelve leaves room for that plus a mistake, and the loop still exits
 * the moment a round returns no tool calls, so an ordinary chat costs one.
 */
const KOALA_TOOL_ROUNDS = 12;

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
      /**
       * Backfill the warmth onto a Koala that predates it.
       *
       * `koalaSeed()` only runs for a user who has no Koala at all, so a change to it reaches
       * nobody who already had one — which is everybody. The chat turn moved to `'tool-turn'` to
       * drop the penalties that were killing tool calls, and that pins temperature at 0.3; without
       * this, every existing Koala would quietly get the colder sampler and none of the warmth
       * meant to replace it.
       *
       * Written only when the key is ABSENT, never over a value: a user who set their own
       * temperature in the Lab chose it, and a migration that overwrites a deliberate setting is
       * worse than one that never ran.
       */
      if (found.overrides?.temperature === undefined) {
        const patched: Persona = {
          ...found,
          overrides: { ...(found.overrides ?? {}), temperature: KOALA_TEMPERATURE },
          updatedAt: new Date().toISOString(),
        };
        await db.savePersona(patched);
        console.log(`[koala] backfilled temperature for ${userId.slice(0, 8)}`);
        return patched;
      }
      return found;
    }
    const now = new Date().toISOString();
    const persona: Persona = {
      ...koalaSeed(), id: uuidv4(), ownerId: userId, createdAt: now, updatedAt: now,
    } as Persona;
    await db.savePersona(persona);
    console.log(`[koala] created the Koala persona for ${userId.slice(0, 8)}`);
    return persona;
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

  const ownedConversations = async (userId: string) =>
    (await db.getConversations()).filter((c) => c.ownerId === userId);

  app.get('/api/koala/conversations', async (req, res) => {
    const mine = await ownedConversations((req as any).user.id);
    // Newest first, and without messages: the list renders titles, and a hundred threads of
    // transcript is a payload nobody asked for.
    res.json(mine
      .map(({ messages, ...rest }) => ({ ...rest, messageCount: messages.length }))
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')));
  });

  app.get('/api/koala/conversations/:id', async (req, res) => {
    const found = (await ownedConversations((req as any).user.id)).find((c) => c.id === req.params.id);
    if (!found) return res.status(404).json({ error: 'No such conversation' });
    res.json(found);
  });

  app.post('/api/koala/conversations', async (req, res) => {
    const now = new Date().toISOString();
    const conversation: Conversation = {
      id: uuidv4(),
      ownerId: (req as any).user.id,
      title: titleFrom(String(req.body?.title ?? '')),
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    await db.saveConversation(conversation);
    res.json(conversation);
  });

  app.delete('/api/koala/conversations/:id', async (req, res) => {
    const found = (await ownedConversations((req as any).user.id)).find((c) => c.id === req.params.id);
    if (!found) return res.status(404).json({ error: 'No such conversation' });
    await db.deleteConversation(found.id);
    res.json({ success: true });
  });

  /**
   * Accepting a proposed project.
   *
   * The tree is created HERE rather than when Koala proposed it — the whole point of a proposal is
   * that nothing exists until a person says so, and a casual question must not litter the Grove.
   * The proposal is kept and marked with what it became, so the card can link to it instead of
   * offering to create a second one.
   */
  app.post('/api/koala/conversations/:id/proposals/:proposalId/accept', async (req, res) => {
    const userId = (req as any).user.id;
    const conversation = (await ownedConversations(userId)).find((c) => c.id === req.params.id);
    if (!conversation) return res.status(404).json({ error: 'No such conversation' });
    const proposal = (conversation.proposedTrees ?? []).find((p) => p.id === req.params.proposalId);
    if (!proposal) return res.status(404).json({ error: 'No such proposal' });
    if (proposal.treeId) return res.status(409).json({ error: 'That project has already been created' });

    const now = new Date().toISOString();
    const tree: Tree = {
      ...normaliseTreeInput({ name: proposal.name, type: proposal.type, goal: proposal.goal }),
      id: uuidv4(),
      ownerId: userId,
      createdAt: now,
      updatedAt: now,
    } as Tree;
    await db.saveTree(tree);
    await db.saveConversation({
      ...conversation,
      proposedTrees: (conversation.proposedTrees ?? [])
        .map((p) => (p.id === proposal.id ? { ...p, treeId: tree.id } : p)),
      updatedAt: now,
    });
    res.json({ tree });
  });

  /**
   * Accepting a proposed app type.
   *
   * Validated AGAIN here, not only when it was proposed. A proposal can sit for a week, and the
   * rules can change under it — a spec that was acceptable then and is not now must be refused at
   * the moment it would become real, which is this one.
   */
  app.post('/api/koala/conversations/:id/specs/:proposalId/accept', async (req, res) => {
    const userId = (req as any).user.id;
    const conversation = (await ownedConversations(userId)).find((c) => c.id === req.params.id);
    if (!conversation) return res.status(404).json({ error: 'No such conversation' });
    const proposal = (conversation.proposedSpecs ?? []).find((p) => p.id === req.params.proposalId);
    if (!proposal) return res.status(404).json({ error: 'No such proposal' });
    if (proposal.acceptedAt) return res.status(409).json({ error: 'That app type already exists' });

    const problems = validateSpec(proposal.spec);
    if (problems.length) return res.status(400).json({ error: explainSpecProblems(problems) });

    /**
     * A replacement overwrites; a built-in never does.
     *
     * Built-ins ship with the platform and a test pins the list, so letting a conversation rewrite
     * one would have a fresh clone and a running instance disagreeing about what `minio` is.
     * Anything else is the user's own, and correcting it is the point.
     */
    const existing = (await db.getAppSpecs()).find((s) => s.id === proposal.id);
    if (existing?.builtIn) {
      return res.status(409).json({ error: `"${proposal.id}" ships with the platform and cannot be replaced.` });
    }

    const now = new Date().toISOString();
    await db.saveAppSpec({
      id: proposal.id,
      spec: proposal.spec as AppSpec,
      // Not built in: the repo does not manage it, and seeding must never touch it.
      builtIn: false,
      ownerId: userId,
      // Kept from the original: a spec being corrected is the same spec, and losing when it first
      // appeared would make the catalogue's history a lie.
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    await db.saveConversation({
      ...conversation,
      proposedSpecs: (conversation.proposedSpecs ?? [])
        .map((p) => (p.id === proposal.id ? { ...p, acceptedAt: now } : p)),
      updatedAt: now,
    });
    console.log(`[app-specs] ${userId.slice(0, 8)} accepted a new app type: ${proposal.id}`);
    res.json({ id: proposal.id });
  });

  /**
   * One general-chat turn.
   *
   * ── WHY THE TOOL ROUNDS ARE NOT STREAMED ──
   * Only the final answer is. A tool round produces no prose worth watching arrive — it produces a
   * function call — and streaming it means reassembling tool_calls from deltas, which is the fiddly
   * part of the branch route. The visible result is the same and the failure modes are far fewer.
   */
  app.post('/api/koala/chat', async (req, res) => {
    const userId = (req as any).user.id;
    const { conversationId, message, sessionId, modelId } = req.body ?? {};
    if (typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'message is required' });
    }

    let conversation = (await ownedConversations(userId)).find((c) => c.id === String(conversationId));
    if (!conversation) return res.status(404).json({ error: 'No such conversation' });

    await ensurePersonas(userId);
    const persona = await ensureKoala(userId);
    /**
     * The same resolution chain the branch route uses: adopted profile, then persona, then request.
     *
     * Sending `overrides: {}` instead produced a turn that reasoned for 365 characters and returned
     * NOTHING — no content and no tool calls, `finish_reason: stop`, with the budget untouched. The
     * knobs that make a reasoning model split its thinking from its answer live in this chain, and
     * without them it thinks and stops.
     */
    const resolved = resolveConfig(await db.getHarnessProfile(userId), persona, {});
    const servers = await koalaServers(userId);
    // Servers this session already hooked up keep their tools without being re-enabled.
    let enabled = enabledForSession(conversation, sessionId);

    let provider, baseUrl, apiKey;
    try {
      ({ provider, baseUrl, apiKey } = await modelService.resolveBaseUrl(userId, modelId));
    } catch (err: any) {
      return res.status(404).json({ error: err.message });
    }

    const now = new Date().toISOString();

    const toolsFor = (names: string[]) => {
      const remote = servers
        .filter((s) => names.includes(s.name))
        .flatMap((s) => toLoopTools(s.name, s.tools));
      return [...KOALA_TOOLS, ...remote];
    };

    /**
     * Reset the thread if this turn would not fit — BEFORE the new message is appended.
     *
     * Before, so the notice lands ahead of the message rather than having to be spliced in behind
     * it, and so the reload path sees the same order. `message.length` is counted explicitly for
     * the same reason: it is not in the array yet, and being one message out here is precisely the
     * difference between resetting and hitting the engine's refusal.
     *
     * See lib/koala-context.ts for why the artifact is assembled rather than summarised, and why
     * the threshold is 0.55 rather than something closer to full.
     */
    {
      const enabledNow = enabledForSession(conversation, sessionId);
      const promptNow = JSON.stringify([
        { role: 'system', content: buildKoalaPrompt(resolved.systemPrompt ?? persona.systemPrompt ?? '', servers, enabledNow) },
        ...historyForPrompt(conversation.messages).map((m) => ({ role: m.role, content: m.content })),
      ]).length + JSON.stringify(toolsFor(enabledNow)).length;

      if (needsHandoff(promptNow, message.length)) {
        conversation = { ...conversation, messages: withHandoff(conversation, now) };
        console.log(`[koala] context reset for conversation ${conversation.id.slice(0, 8)}`);
      }
    }

    conversation = {
      ...conversation,
      // Named from the first thing said, so the list never shows a row of "New conversation".
      title: conversation.messages.length === 0 ? titleFrom(message) : conversation.title,
      messages: trimKoalaThread([...conversation.messages, { role: 'user' as const, content: message, at: now }]),
      updatedAt: now,
    };
    await db.saveConversation(conversation);

    /**
     * Sliced at the last handoff, so a reset thread does not silently keep paying for the messages
     * it just summarised. With no handoff this is the whole conversation, unchanged.
     */
    const conversationFor = (list: string[]) => [
      { role: 'system', content: buildKoalaPrompt(resolved.systemPrompt ?? persona.systemPrompt ?? '', servers, list) },
      ...historyForPrompt(conversation!.messages).map((m) => ({ role: m.role, content: m.content })),
    ];

    const upstreamAbort = new AbortController();
    res.on('close', () => upstreamAbort.abort());

    /**
     * What this turn will actually put in the window: the messages AND the tool schemas.
     *
     * The tools were not being counted, and they are not a rounding error — KOALA_TOOLS alone is
     * roughly 8KB of JSON, and every MCP server enabled for the session adds its whole schema set
     * on top. So the estimate was worst precisely when the prompt was largest, and it under-read by
     * more the more services a user had hooked up. Both the reply budget and the pressure check
     * below are only as honest as this number.
     */
    const promptCharsFor = (messages: unknown, names: string[]) =>
      JSON.stringify(messages).length + JSON.stringify(toolsFor(names)).length;

    const call = async (
      messages: unknown,
      stream: boolean,
      names: string[],
      extra?: Record<string, unknown>,
    ) => fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify(buildModelRequest({
        /**
         * ── 'tool-turn', NOT 'conversation', AND IT IS NOT A STYLE CHOICE ──
         * `conversationSampling` carries frequency_penalty 0.4 and presence_penalty 0.3, and
         * exp-penalties-001 measured those scoring 0/12 on tool calling against 12/12 without —
         * perfect separation across two tasks and two prompts, with the failing runs making ZERO
         * tool calls. The mechanism is plain: emitting a call means reproducing the function names
         * and JSON keys already in the prompt, and these penalties push away from exactly those
         * tokens. It gets worse with more tools, and this turn offers eleven plus every MCP tool
         * the session has enabled — the worst case that experiment describes.
         *
         * `toolTurnSampling` drops them and keeps DRY on TabbyAPI, which the same experiment found
         * innocent (3/3 with DRY alone). What it also does is pin temperature at 0.3, which is
         * wrong here — so the persona carries KOALA_TEMPERATURE and `resolved.overrides` puts it
         * back, below anything the user set in the Lab.
         */
        turn: 'tool-turn',
        ...(provider!.kind ? { kind: provider!.kind } : {}),
        messages,
        tools: toolsFor(names),
        stream,
        maxTokens: fittedMaxTokens(KOALA_MAX_TOKENS, promptCharsFor(messages, names)),
        ...(provider!.model ? { model: provider!.model } : {}),
        overrides: resolved.overrides,
        ...(extra ? { extra } : {}),
      }).body),
      signal: upstreamAbort.signal,
    });

    try {
      const turn: any[] = conversationFor(enabled);
      const enabledNow: string[] = [];
      const proposed: ProposedTree[] = [];

      /**
       * Streamed from the first round, not just the last.
       *
       * The rounds used to be non-streamed on the reasoning that a tool round produces no prose
       * worth watching. That was wrong twice over: a reasoning model produces a great deal of
       * thinking per round, and a turn that spends eighty seconds deciding what to do showed
       * "Koala is thinking…" the whole time with nothing behind it. Branch chat has always shown
       * its deliberation, and this is the same model doing the same kind of work.
       */
      /**
       * `openSse` rather than three hand-written headers — and this route was missing a fourth.
       *
       * It had no `X-Accel-Buffering: no`, which `/api/chat` sets with a comment explaining why:
       * nginx buffers proxied responses by default, so every frame arrives at once when the
       * response ends. Behind the platform's own proxy this stream was not streaming; it looked
       * like a model that thought for a long time and then answered instantly.
       */
      openSse(res);

      let answer = '';
      /**
       * Prose the model said on a round that ALSO called a tool.
       *
       * `answer` is only assigned on the round that stops, so "Let me check the logs first —"
       * streamed to the reader live and then vanished on reload: the persisted message was whatever
       * the final round said, or empty. The reader watched Koala say something and then found it
       * gone, which reads as the app losing their conversation.
       *
       * Kept as a fallback rather than concatenated: when the last round DID answer, that answer is
       * the reply and the running commentary before it is noise.
       */
      let spoken = '';
      /** Whether the last round still wanted tools when the round budget ran out. */
      let exhaustedRounds = false;
      /** What this turn did, for the transcript and for the handoff artifact. See ConversationMessage. */
      const toolCalls: ConversationToolCall[] = [];

      /**
       * Announced BEFORE the call, which is the whole point.
       *
       * `get_logs` shells out to kubectl and an MCP call crosses the network; both were rendering
       * as "Koala is thinking…" with nothing behind them. The pill appears while the work happens
       * and flips when the result lands.
       */
      const announceCall = (c: { id: string; name: string; arguments: string }) => {
        sendFrame(res, {
          toolCall: { id: c.id, name: c.name, args: (c.arguments || '').slice(0, MAX_TOOL_CALL_ARGS) },
        });
      };

      /**
       * The result, digested.
       *
       * Never the full payload: a remote result runs to MAX_REMOTE_RESULT and is not persisted, so
       * streaming it whole would make the live view and the reloaded view disagree about the same
       * turn. Both sides get the same clipped digest, so they agree by construction.
       */
      const recordResult = (c: { id: string; name: string; arguments: string }, result: string) => {
        const ok = !toolRefused(result);
        const digest = result.slice(0, MAX_TOOL_CALL_DIGEST);
        if (toolCalls.length < MAX_TOOL_CALLS_PER_MESSAGE) {
          toolCalls.push({
            id: c.id, name: c.name,
            args: (c.arguments || '').slice(0, MAX_TOOL_CALL_ARGS),
            ok, digest,
          });
        }
        sendFrame(res, { toolResult: { id: c.id, ok, digest } });
      };
      let thinking = '';

      const drain = async (upstream: Response) => {
        const scanner = new ToolCallScanner();
        let content = '';
        const reader = (upstream.body as any)?.getReader?.();
        if (!reader) return { calls: [], content };
        const decoder = new TextDecoder();
        let buffered = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          // Tool calls arrive as fragments keyed by index — the scanner reassembles them, and
          // reading only the first delta would execute a call with empty arguments.
          scanner.push(chunk);
          buffered += chunk;
          const lines = buffered.split('\n');
          buffered = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const payload = line.slice(6).trim();
            if (!payload || payload === '[DONE]') continue;
            try {
              const delta = JSON.parse(payload)?.choices?.[0]?.delta;
              // Two channels, forwarded separately so the UI can collapse one and show the other.
              if (delta?.reasoning_content) {
                thinking += delta.reasoning_content;
                sendFrame(res, { reasoning: delta.reasoning_content });
              }
              if (delta?.content) {
                content += delta.content;
                sendFrame(res, { delta: delta.content });
              }
            } catch { /* a partial frame; the next chunk completes it */ }
          }
        }
        return { calls: scanner.result(), content };
      };

      for (let round = 0; round < KOALA_TOOL_ROUNDS; round++) {
        /**
         * Trimmed per round, because ONE turn can outgrow the window on its own.
         *
         * `turn` grows by an assistant message plus a tool result every round, and a remote result
         * is allowed up to MAX_REMOTE_RESULT characters — twelve rounds of those is ~144KB against
         * a 32k-token window. The thread being short is no protection: a single question that makes
         * Koala read three sets of pod logs is enough.
         *
         * `trimConversation` is the leaf loop's, unchanged, because this is exactly the shape it
         * was written for: it blanks over-budget TOOL output rather than deleting it, since
         * removing a `tool` message orphans the `tool_calls` entry that referenced it and the API
         * rejects the request outright. PRESERVE_HEAD=2 pins the system prompt and the oldest
         * message, and it walks newest-first, so the rounds that the next decision depends on stay
         * intact. Reassigned into a local rather than mutating `turn`, so the untrimmed array is
         * still what gets appended to and what the next round trims from scratch.
         */
        exhaustedRounds = round === KOALA_TOOL_ROUNDS - 1;
        const sent = trimConversation(turn);

        /**
         * Refuse before the engine does, with something a reader can act on.
         *
         * `fittedMaxTokens` floors at MIN_TURN_TOKENS, so once the prompt exceeds the window it
         * stops reporting a smaller budget and just asks for 600 tokens on top of a prompt that
         * already does not fit. The engine allocates the pair up front and returns an opaque 400.
         * Nothing downstream recovers from that, and the reader sees a chat that stopped working.
         */
        if (fittedMaxTokens(KOALA_MAX_TOKENS, promptCharsFor(sent, enabled)) <= MIN_TURN_TOKENS) {
          sendFrame(res, {
            error: 'This conversation has outgrown the model\'s context window. Start a new one to keep going — '
              + 'the trees and specs you have already accepted are safe.',
          });
          break;
        }

        const step = await call(sent, true, enabled);
        if (!step.ok || !step.body) {
          sendFrame(res, { error: `Model returned ${step.status}` });
          break;
        }
        const { calls, content } = await drain(step as any);
        console.log(`[koala] round ${round}: calls=${calls.length} content=${content.length} thinking=${thinking.length}`);
        if (content.trim()) spoken = content;

        if (!calls.length) {
          /**
           * The round that stops IS the answer, and it has already been streamed to the reader.
           *
           * Asking again for a "final" reply cost an inference and returned nothing: measured, a
           * round produced 491 characters, was discarded, and the fresh call on an identical
           * conversation came back empty. The model had said its piece and would not repeat it.
           */
          answer = content;
          exhaustedRounds = false;
          break;
        }

        turn.push({
          role: 'assistant',
          content: content || null,
          tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })),
        });

        for (const c of calls) {
          announceCall(c);
          /**
           * A tool belonging to an enabled service goes to that service.
           *
           * Missing this made the whole mechanism a loop: the model enabled `github-mcp`, was
           * offered `github-mcp__github-get-repo`, called it, and the runner — which only knows
           * Koala's own tools — answered "No tool named …". It retried until the budget died with
           * `finish_reason: length`. 351 seconds, no answer.
           *
           * `routeCall` refuses any name that is not `server__tool` for an ENABLED service, so
           * running it first cannot swallow Koala's own tools.
           */
          const route = routeCall(c.name, enabled);
          if (route) {
            const server = servers.find((sv) => sv.name === route.server);
            let text: string;
            try {
              const registry = new McpRegistryService(db, userId, (n: string) => resolveMcpProbeUrl(n));
              const got = server
                ? await registry.call(server, route.tool, JSON.parse(c.arguments || '{}'))
                : { text: `"${route.server}" is no longer running.`, isError: true };
              text = got.text;
            } catch (err: any) {
              text = `That call failed: ${String(err?.message ?? err).slice(0, 200)}`;
            }
            const trimmed = text.length > MAX_REMOTE_RESULT
              ? `${text.slice(0, MAX_REMOTE_RESULT)}\n…[trimmed, ${text.length} characters total]`
              : text;
            recordResult(c, trimmed);
            turn.push({ role: 'tool', tool_call_id: c.id, name: c.name, content: trimmed });
            continue;
          }

          const out = await runKoalaTool(
            {
              db, userId, conversationId: conversation!.id, sessionId,
              servers, webSearch: executeWebSearch, fetchWebPage: executeFetchWebPage,
              /**
               * Read-only, and only ever the two diagnostic commands the runner builds — it takes
               * an argument array, never a string, so nothing a model writes reaches a shell.
               */
              kubectl: (a: string[]) => new InfrastructureService().runKubectl(a).then((r: any) =>
                typeof r === 'string' ? r : (r?.stdout ?? '')),
            },
            { name: c.name, arguments: c.arguments },
          );
          /**
           * A service enabled mid-turn widens the NEXT round's tools.
           *
           * Without this the model enables something and cannot call it until the user sends
           * another message, which makes the lazy mechanism a two-message ritual.
           */
          if (out.enabled && !enabled.includes(out.enabled)) {
            enabled = [...enabled, out.enabled];
            enabledNow.push(out.enabled);
            sendFrame(res, { enabled: [out.enabled] });
            // The system message carries the catalogue, so it is rewritten with the new state.
            turn[0] = { role: 'system', content: buildKoalaPrompt(resolved.systemPrompt ?? persona.systemPrompt ?? '', servers, enabled) };
          }
          if (out.proposed) {
            proposed.push(out.proposed);
            sendFrame(res, { proposedTree: out.proposed });
          }
          if (out.proposedSpec) {
            sendFrame(res, { proposedSpec: out.proposedSpec });
          }
          recordResult(c, out.content);
          turn.push({ role: 'tool', tool_call_id: c.id, name: c.name, content: out.content });
        }
      }

      /**
       * ── ONE LAST ROUND, WITH THE TOOLS TAKEN AWAY ──
       *
       * Twelve rounds that all called tools leaves `answer` empty, and the turn persisted a blank
       * assistant message: the reader watched Koala work for a minute and got an empty bubble.
       *
       * This does NOT contradict the decision recorded above about not asking for a "final" reply.
       * That one is about a round which already produced content and then stopped — asking again
       * there was measured as an inference that returned nothing, because the model had said its
       * piece. This is the opposite case: a round that produced NO content and was still reaching
       * for tools. Different situation, different answer. Someone will want to unify these; the
       * distinguishing fact is whether the loop ended by choice or by running out.
       *
       * `tool_choice: 'none'` is what makes it a wrap-up rather than a thirteenth working round —
       * the model cannot decide to keep going, which is the whole reason the budget was reached.
       * The same shape as the agent loop's forced `finish` turn.
       */
      if (exhaustedRounds && !answer) {
        try {
          const last = await call(trimConversation(turn), true, enabled, { tool_choice: 'none' });
          if (last.ok && last.body) {
            const { content } = await drain(last as any);
            if (content.trim()) answer = content;
          }
        } catch (err: any) {
          // A wrap-up that fails must not take down the turn's own record — `spoken` and the tool
          // list below are still true, and still worth persisting.
          console.warn(`[koala] forced wrap-up failed: ${err.message}`);
        }
      }

      /**
       * Still nothing to show. Say so as a notice rather than persisting an empty bubble, which
       * reads as the app breaking rather than as the turn running long.
       */
      const ranDry = exhaustedRounds && !answer && !spoken;

      // Persisted after the stream, so a reader who disconnects mid-answer does not lose what the
      // model already said.
      const saved = (await db.getConversations()).find((c) => c.id === conversation!.id);
      if (saved) {
        await db.saveConversation({
          ...saved,
          messages: [...saved.messages, {
            role: 'assistant' as const,
            // `spoken` covers the turn that talked while working and then ran out of rounds —
            // without it that message persists empty and the UI shows a blank bubble.
            content: answer || spoken
              || `Koala used all ${KOALA_TOOL_ROUNDS} tool rounds without reaching an answer. `
                + 'Ask again and it will continue from what it found.',
            at: new Date().toISOString(),
            ...(thinking.trim() ? { reasoning: thinking.slice(-20000) } : {}),
            ...(enabledNow.length ? { enabled: enabledNow } : {}),
            ...(toolCalls.length ? { toolCalls } : {}),
            // A notice, not a boundary: this summarises nothing, so it must not truncate the next
            // prompt the way a handoff does. See ConversationMessage.handoff.
            ...(ranDry ? { notice: true as const } : {}),
          }],
          updatedAt: new Date().toISOString(),
        });
      }
      endSse(res);
    } catch (err: any) {
      console.error(`[koala] turn failed: ${err.message}`);
      if (!res.headersSent) res.status(500).json({ error: err.message });
      else res.end();
    }
  });

  /** ── MODELS / CHAT — agent harness Phase A (~/.claude/plans/agent-harness.md) ── */

  /**
   * Runs the extraction model over a conversation and returns proposed leaves.
   *
   * Non-streaming, low temperature, schema-constrained: this is a narrow deterministic job, not a
   * conversation. Every failure returns an empty array — an extractor that is down, slow or
   * confused must never fail the chat it was called from, because the user already has their reply.
   */
  async function extractViaModel(
    extractor: { baseUrl: string; apiKey?: string; provider: { model: string; name: string } },
    turns: { role: string; content: string }[],
  ): Promise<LeafProposal[]> {
    const payloadBase = {
      ...(extractor.provider.model ? { model: extractor.provider.model } : {}),
      messages: [
        { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
        { role: 'user', content: buildExtractionPrompt(turns) },
      ],
      template_vars: EXTRACTION_TEMPLATE_VARS,
      temperature: 0.1,
      max_tokens: 800,
      stream: false,
    };

    // Try standard OpenAI / vLLM json_schema response_format first, then json_object, then legacy top-level json_schema
    const formats: Record<string, unknown>[] = [
      {
        ...payloadBase,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'leaf_proposals', schema: EXTRACTION_SCHEMA },
        },
      },
      {
        ...payloadBase,
        response_format: { type: 'json_object' },
      },
      {
        ...payloadBase,
        json_schema: EXTRACTION_SCHEMA,
      },
    ];

    for (const bodyPayload of formats) {
      try {
        const res = await fetch(`${extractor.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(extractor.apiKey ? { authorization: `Bearer ${extractor.apiKey}` } : {}),
          },
          body: JSON.stringify(bodyPayload),
          signal: AbortSignal.timeout(30_000),
        });

        if (!res.ok) {
          continue; // Try next payload format fallback
        }

        const body = (await res.json()) as any;
        const text = String(body?.choices?.[0]?.message?.content ?? '');
        const proposals = parseExtractionResult(text, MAX_PROPOSALS_PER_REPLY);
        if (proposals.length > 0) return proposals;
        if (text.trim()) return proposals; // Valid response (even if 0 proposals)
      } catch (err: any) {
        console.warn(`[extract] attempt failed for ${extractor.provider.name}: ${err.message}`);
      }
    }

    return [];
  }






  /**
   * Streaming chat against one of the caller's own model endpoints.
   *
   * Proxied rather than called from the browser because the endpoint is only reachable through a
   * process-local kubectl port-forward — handing the browser that URL would neither work nor be
   * safe. The upstream body is passed through untouched: vLLM and TabbyAPI both speak the OpenAI
   * schema, and re-encoding it here would mean tracking every field either adds.
   */
  app.post('/api/chat', async (req, res) => {
    const { modelId, messages, stream = true, leafId, branchId, mode: rawMode, personaId, ...rest } = req.body ?? {};
    // Unknown or missing modes fall back to 'auto' rather than erroring: a chat request should
    // never fail because a selector was out of date.
    const mode: ChatMode = isChatMode(rawMode) ? rawMode : 'auto';
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages is required' });
    }

    // There is no plan MODE. Proposing is always available, and an explicit /plan only escalates
    // it — stronger instructions and a bigger budget — so the user can force it when the model
    // would have declined. Parsed from the LAST message, which is the one being sent now.
    const lastIndex = messages.length - 1;
    const command = parseChatCommand(String(messages[lastIndex]?.content ?? ''));
    /**
     * What already exists on this branch, so the model is not blind to its own output.
     *
     * Without it the model proposes the same work every turn — from its point of view nothing was
     * ever created. Skipped in chat mode, where no leaves are in play and the tokens would be
     * spent describing work the user explicitly did not want discussed.
     */
    /**
     * This conversation's work, and the rest of the project's.
     *
     * The context used to stop at the branch, so a second conversation about the same project
     * started blind to everything the first one built — it could not see a single finished leaf and
     * had no way to avoid proposing the same work over again. Sibling branches are found through
     * the tree, so an unfiled conversation correctly has none.
     */
    const ownAll = await ownedLeaves((req as any).user.id);
    const branchLeaves = branchId ? ownAll.filter((l) => l.branchId === branchId) : [];

    let siblingLeaves: typeof ownAll = [];
    let siblingBranches: Awaited<ReturnType<typeof ownedBranches>> = [];
    if (branchId) {
      const all = await ownedBranches((req as any).user.id);
      const branch = all.find((b) => b.id === branchId);
      if (branch?.treeId) {
        siblingBranches = all.filter((b) => b.treeId === branch.treeId && b.id !== branchId);
        const siblingIds = new Set(siblingBranches.map((b) => b.id));
        siblingLeaves = ownAll.filter((l) => siblingIds.has(l.branchId));
      }
    }

    /**
     * What this turn actually runs under: built-in constants, then the adopted profile, then the
     * chosen persona, then whatever the client posted.
     *
     * The profile step is new. This route read no profile at all — measured, not assumed — so a
     * configuration promoted from an experiment applied to leaf runs and to the Lab while chat
     * quietly kept running the shipped values, and the promote dialog's "applies to leaf runs too"
     * read as "applies everywhere".
     */
    const chatPersona = personaId
      ? (await db.getPersonas()).find((p) => p.id === String(personaId) && p.ownerId === (req as any).user.id) ?? null
      : null;
    if (personaId && !chatPersona) {
      // Not silently ignored: a turn answered by nobody in particular, when a persona was asked
      // for, is the failure that looks like the model forgetting who it is.
      return res.status(404).json({ error: 'No such persona' });
    }
    const resolved = resolveConfig(
      await db.getHarnessProfile((req as any).user.id),
      chatPersona,
      rest,
    );

    // `/plan` overrides the mode for this turn; otherwise the mode decides.
    const planning = command.command === 'plan' || mode === 'plan';
    const explicitPlan = planning;
    const extracting = planning || mode === 'auto';
    const strategy = estimatePromptComplexity(messages, mode, explicitPlan);
    const offerTools = Boolean(branchId) && mode !== 'chat' && (explicitPlan || strategy.tier !== 'casual');
    /**
     * What this KIND of project means by finished.
     *
     * `TREE_TYPES` has carried a `doneMeans` for eleven types since trees were introduced and
     * nothing ever read one. `api-service` has said "its tests pass, it builds, it deploys, and the
     * endpoint responds" the whole time, while planners wrote whatever acceptance occurred to them —
     * which is how a run ended with `echo` as its only check.
     */
    const planTree = branchId
      ? await (async () => {
          const b = (await ownedBranches((req as any).user.id)).find((x) => x.id === branchId);
          return b?.treeId
            ? (await ownedTrees((req as any).user.id)).find((t) => t.id === b.treeId)
            : undefined;
        })()
      : undefined;
    // Resolved from the owner's records rather than a constant table — see lib/tree-types.ts.
    const doneMeans = planTree
      ? (await resolveTreeType(db, planTree.ownerId, planTree.type))?.doneMeans
      : undefined;

    const outboundMessages = buildOutboundMessages({
      ...(doneMeans ? { doneMeans } : {}),
      messages,
      lastIndex,
      prompt: explicitPlan ? PLAN_SYSTEM_PROMPT : extracting ? AMBIENT_PROPOSAL_PROMPT : undefined,
      leaves: branchLeaves,
      siblingLeaves,
      siblingBranches,
      // Only when tools are actually offered — otherwise it is instructions about a capability the
      // model does not have this turn.
      ...(offerTools ? { toolPrompt: TOOL_DISCIPLINE_PROMPT } : {}),
      ...(explicitPlan ? { planText: command.text } : {}),
      ...(resolved.systemPrompt ? { personaPrompt: resolved.systemPrompt } : {}),
    });

    let provider, baseUrl, apiKey;
    try {
      ({ provider, baseUrl, apiKey } = await modelService.resolveBaseUrl((req as any).user.id, modelId));
    } catch (err: any) {
      // A missing/unowned model is the caller's problem, not a server fault.
      return res.status(404).json({ error: err.message });
    }

    /**
     * One builder for every call this turn makes.
     *
     * Built-in sampling, then the resolved chain written through the registry so each knob lands
     * where the engine actually reads it. Four call sites used to assemble this inline and no two
     * agreed: three spread the raw request instead of the resolved chain, all four applied the
     * built-in defaults LAST (which silently undid the adopted profile), and the hand-rolled
     * filter sent `think` as a top-level field the engine ignores.
     */
    const turnRequest = (
      messages: unknown,
      opts: { tools?: unknown; stream: boolean; maxTokens: number; reasoningEffort?: string; extra?: Record<string, unknown> },
    ) => buildModelRequest({
      turn: 'conversation',
      ...(provider.kind ? { kind: provider.kind } : {}),
      messages,
      ...(opts.tools ? { tools: opts.tools } : {}),
      stream: opts.stream,
      maxTokens: opts.maxTokens,
      ...(opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
      ...(provider.model ? { model: provider.model } : {}),
      overrides: resolved.overrides,
      ...(opts.extra ? { extra: opts.extra } : {}),
    }).body;


    // Abort the upstream request if the browser goes away mid-stream, or a closed tab leaves a
    // generation running on the GPU until it finishes.
    const upstreamAbort = new AbortController();
    res.on('close', () => upstreamAbort.abort());

    try {
      /**
     * What the persona you are TALKING TO may call.
     *
     * Resolved once per turn, not per round: the registry caches introspection but the listing is
     * still a database read plus a NodePort lookup per server, and a turn can take eight rounds.
     *
     * Soft in every direction — a registry that cannot be reached leaves chat exactly as it was
     * rather than failing a conversation over a service it may not even need.
     */
    let chatMcp = NO_CHAT_MCP;
    try {
      if (wantsMcp(chatPersona).length) {
        const reg = new McpRegistryService(db, (req as any).user.id, (n: string) => resolveMcpProbeUrl(n));
        chatMcp = chatMcpFor(chatPersona, await reg.listWithTools(), (srv, tool, a) => reg.call(srv, tool, a));
        if (chatMcp.missing.length) {
          console.warn(`[chat] persona named MCP servers that are not usable — ${chatMcp.missing.join(', ')}`);
        }
      }
    } catch (err: any) {
      console.warn(`[chat] could not resolve MCP tools for this turn: ${err.message}`);
    }
    /** The board tools plus whatever the persona was granted. One array, built once. */
    const turnTools = chatMcp.tools.length ? [...LEAF_TOOLS, ...chatMcp.tools] : LEAF_TOOLS;

    const upstream = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // Only ever the caller's own stored key, decrypted per request — never logged, never
          // returned to the browser.
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        // Omit `model` entirely when unknown rather than falling back to the deployment NAME, which
        // is never a valid model id. TabbyAPI ignores the field (confirmed live: it serves
        // "turboderp-qwen3-6-27b-exl3-5-00bpw" regardless of what is sent, having derived its own
        // id from the repo and bitrate), but a stricter server would reject "Tabbyapi-Production"
        // outright — and single-model endpoints generally serve whatever they loaded.
        body: JSON.stringify(turnRequest(outboundMessages, {
          // Offered only when in proposal/plan mode on a task-relevant turn. Selective tool framing
          // prevents casual Q&A turns from degenerating into tool-schema deliberation loops.
          ...(offerTools ? { tools: turnTools } : {}),
          stream,
          /**
           * Fitted to what the window has left, not asked for flat.
           *
           * The engine allocates prompt + max_tokens up front and refuses the job if the pair does
           * not fit — `Job requires 136 pages (only 128 available)`, which is 34,816 against a
           * 32,768 window. The agent loop was fixed for exactly this and the chat route never was,
           * so a plan turn with a long system prompt was refused before generating a single token.
           */
          maxTokens: fittedMaxTokens(rest.max_tokens ?? strategy.maxTokens, JSON.stringify(outboundMessages).length),
          reasoningEffort: rest.reasoning_effort ?? strategy.reasoningEffort,
          extra: {
            max_completion_tokens: fittedMaxTokens(rest.max_tokens ?? strategy.maxTokens, JSON.stringify(outboundMessages).length),
            // Streaming responses omit usage unless asked, and then only in the final chunk.
            ...(stream ? { stream_options: { include_usage: true } } : {}),
          },
        })),
        signal: upstreamAbort.signal,
      });

      if (!upstream.ok || !upstream.body) {
        const detail = await upstream.text().catch(() => '');
        // Surface the engine's own message — vLLM's errors (bad sampling params, context length
        // exceeded) are specific and actionable, and replacing them with a generic 502 throws away
        // the only useful information.
        return res.status(upstream.status).json({ error: detail || `Model returned HTTP ${upstream.status}` });
      }

      res.setHeader('Content-Type', stream ? 'text/event-stream' : 'application/json');
      res.setHeader('Cache-Control', 'no-cache');
      // Without this, a proxy in front of the backend may buffer the whole stream and defeat the
      // point of streaming at all.
      res.setHeader('X-Accel-Buffering', 'no');

      const targetModelId = provider.model ?? modelId ?? 'default-model';
      const globalProfile = await db.getModelThinkingProfile?.(targetModelId).catch(() => null) ?? undefined;
      const lastUserMsg = messages[messages.length - 1]?.content ?? '';
      const featureExtractor = new ThoughtFeatureExtractor(lastUserMsg);

      // Usage is watched as the stream passes through rather than read off a response body —
      // see lib/token-usage.ts. The client gets every byte unchanged; this only observes.
      const scanner = new UsageScanner();
      // Accumulated for every branch-scoped reply now, not just extracting ones: the transcript is
      // persisted server-side, so it must be captured even in chat mode. String accumulation is
      // cheap next to the inference that produced it.
      const content = branchId ? new ContentScanner() : undefined;
      const finishScanner = new FinishReasonScanner();
      const reasoningScanner = new ReasoningScanner();
      const decoder = new TextDecoder();
      let wasInterrupted = false;

      /**
       * Stream a response through to the client, watching for tool calls.
       *
       * Tool frames carry no content, so they are NOT forwarded — the client would render empty
       * assistant turns. Everything else passes through byte for byte.
       */
      const pump = async (body: ReadableStream<Uint8Array>): Promise<ToolCall[]> => {
        const tools = new ToolCallScanner();
        const reader = body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          scanner.push(text);
          content?.push(text);
          tools.push(text);
          finishScanner.push(text);
          const addedReasoning = reasoningScanner.push(text);
          if (addedReasoning) {
            featureExtractor.pushReasoning(addedReasoning);
          }

          const features = featureExtractor.extract();
          const sensitivity = (rest.thoughtMonitorSensitivity as any) ?? 'medium';
          const threshold = rest.failurePredictionThreshold !== undefined ? Number(rest.failurePredictionThreshold) : 0.85;
          const repeatCap = rest.ngramRepeatThreshold !== undefined ? Number(rest.ngramRepeatThreshold) : 5;
          const pred = predictFailure(features, globalProfile, sensitivity, threshold, repeatCap);
          if (pred.shouldInterrupt && !wasInterrupted) {
            wasInterrupted = true;
            const reasonMsg = pred.reason ?? 'Overthinking loop detected';
            sendFrame(res, { interruptedReason: reasonMsg });
            upstreamAbort.abort();
            break;
          }

          forwardChunk(res, value);
        }
        return tools.result();
      };

      let calls = await pump(upstream.body);

      /**
       * Tool loop. Each round is a full inference pass, so it is capped — a model that keeps
       * calling tools without answering is a loop, not a thorough one.
       */
      const conversation: any[] = [...outboundMessages];

      /**
       * Whether this turn created leaves through the TOOLS.
       *
       * Tracked here rather than read off `calls`, which the loop below overwrites with each
       * round's result and which is empty by the time anyone would ask.
       */
      let proposedViaTools = false;

      for (let round = 0; round < MAX_TOOL_ROUNDS && calls.length > 0 && branchId; round++) {
        conversation.push({
          role: 'assistant',
          content: null,
          tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })),
        });
        for (const call of calls) {
          /**
           * A qualified remote name goes to its server; everything else is a board tool.
           *
           * `routeCall` refuses any name that is not `server__tool` for a granted server, so this
           * cannot swallow `propose_leaf` — and checking it FIRST is safe only because of that
           * refusal. The executor's loop had the same ordering bug caught by a test: trying remote
           * before built-in let a handler shadow `run_command`.
           */
          const remote = await chatMcp.call(call.name, JSON.parse(call.arguments || '{}'));
          if (remote) {
            conversation.push({
              role: 'tool', tool_call_id: call.id, name: call.name,
              content: JSON.stringify({ ...(remote.isError ? { error: remote.text } : { result: remote.text }) }),
            });
            continue;
          }
          const result = await runLeafTool((req as any).user.id, String(branchId), call);
          // A refused call created nothing, so it must not suppress extraction — that would turn a
          // rejected proposal into a turn that proposed nothing at all.
          if (call.name === 'propose_leaf' && !toolRefused(result)) proposedViaTools = true;
          conversation.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: result });
        }

        const followUp = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
          body: JSON.stringify(turnRequest(conversation, {
            tools: turnTools,
            stream: true,
            /**
           * Fitted to what the window has left, not asked for flat.
           *
           * The engine allocates prompt + max_tokens up front and refuses the job if the pair does
           * not fit — `Job requires 136 pages (only 128 available)`, which is 34,816 against a
           * 32,768 window. The agent loop was fixed for exactly this and the chat route never was,
           * so a plan turn with a long system prompt was refused before generating a single token.
           */
          maxTokens: fittedMaxTokens(rest.max_tokens ?? strategy.maxTokens, JSON.stringify(outboundMessages).length),
            reasoningEffort: rest.reasoning_effort ?? strategy.reasoningEffort,
            extra: {
              max_completion_tokens: fittedMaxTokens(rest.max_tokens ?? strategy.maxTokens, JSON.stringify(outboundMessages).length),
              stream_options: { include_usage: true },
            },
          })),
          signal: upstreamAbort.signal,
        });
        if (!followUp.ok || !followUp.body) break;
        calls = await pump(followUp.body);
      }

      /**
       * Every proposed leaf must have somebody to do it.
       *
       * A persona carries the whole environment now — image, network, tools, budget, where the
       * output goes — so a leaf without one does not run with defaults, it runs as nobody. The
       * planner is the thing that decides who does what, and this is what holds it to that: it is
       * asked again, with the leaves named and the personas listed, because the usual cause is a
       * model that did not have the names to hand.
       *
       * Bounded, and then handed over. Refusing the leaves would throw away a decomposition that is
       * probably correct over a field the model forgot; choosing for it would be exactly the guess
       * this design removed.
       */
      /**
       * Settle whatever this turn proposed: assign personas, then start what is routine.
       *
       * Called from BOTH paths that create leaves. It used to be inline and gated on
       * `proposedViaTools`, so a plan the model wrote as PROSE — turned into leaves by the
       * ambient extractor further down — got neither. Measured on a real end-to-end run: zero
       * propose_leaf calls, two leaves created by extraction, one of them with no persona, and
       * nothing started. The leaf with no persona could not even be accepted afterwards,
       * because a leaf with no persona has no repository and its work would be discarded.
       */
      const settleProposals = async () => {
        if (!branchId) return;
        for (let round = 0; round < MAX_ASSIGNMENT_ROUNDS; round++) {
          const missing = unassignedLeaves(await db.getLeaves(), String(branchId));
          if (!missing.length) break;

          const mine = (await db.getPersonas()).filter((p) => p.ownerId === (req as any).user.id);
          if (!mine.length) break; // Nothing to choose from; the notice below says so instead.

          conversation.push({ role: 'user', content: buildAssignmentPrompt(missing, mine) });
          const retry = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
            body: JSON.stringify(turnRequest(conversation, {
              tools: LEAF_TOOLS,
              stream: false,
              maxTokens: strategy.maxTokens,
            })),
            signal: upstreamAbort.signal,
          }).catch(() => undefined);
          if (!retry?.ok) break;

          const body: any = await retry.json().catch(() => undefined);
          const retryCalls = body?.choices?.[0]?.message?.tool_calls ?? [];
          if (!retryCalls.length) break;

          conversation.push({ role: 'assistant', content: null, tool_calls: retryCalls });
          for (const c of retryCalls) {
            const out = await runLeafTool((req as any).user.id, String(branchId), { name: c.function.name, arguments: c.function.arguments });
            conversation.push({ role: 'tool', tool_call_id: c.id, name: c.function.name, content: out });
          }
        }

        /**
         * Whatever the planner still would not assign goes to the user.
         *
         * Written to the branch as a notice rather than logged, because the person who has to
         * decide is the one reading the conversation — a warning in a server log is a warning
         * nobody receives.
         */
        const stillMissing = unassignedLeaves(await db.getLeaves(), String(branchId));
        if (stillMissing.length) {
          const latest = (await db.getBranches()).find((b: Branch) => b.id === branchId);
          if (latest) await db.saveBranch(withNotice(latest, buildUnassignedNotice(stillMissing)));
          console.warn(`[chat] ${stillMissing.length} leaf(s) on branch ${String(branchId).slice(0, 8)} have no persona`);
        }

        const all = (await ownedLeaves((req as any).user.id)).filter((l) => l.branchId === branchId);
        const branch = (await db.getBranches()).find((b: Branch) => b.id === branchId);
        const policy: AutoAcceptPolicy = {
          ...DEFAULT_POLICY,
          // The branch's setting, unless this request said otherwise. Off unless switched on:
          // accepting work spends a budget and runs commands in a sandbox.
          enabled: typeof rest.autoAccept === 'boolean' ? rest.autoAccept : branch?.autoAccept === true,
        };
        const reviewed = reviewBatch(all.filter((l) => l.status === 'proposed'), all, policy);

        const started: string[] = [];
        const held: string[] = [];
        for (const { leaf, verdict } of reviewed) {
          if (!verdict.accept) {
            if (policy.enabled) held.push(`${leaf.title} — ${verdict.reason}`);
            continue;
          }
          const outcome = await acceptLeaf(
            {
              db,
              startLeaf: (l) => temporalBridge!.startLeaf(l),
              signalLeaf: (id, sig, payload) => temporalBridge!.signalLeaf(id, sig, payload),
            },
            leaf,
            // Re-read, because accepting one leaf changes what blocks the next.
            (await ownedLeaves((req as any).user.id)).filter((l) => l.branchId === branchId),
          );
          if (outcome.ok) started.push(leaf.title);
          else held.push(`${leaf.title} — ${outcome.error}`);
        }

        if (started.length || held.length) {
          const latest = (await db.getBranches()).find((b: Branch) => b.id === branchId);
          if (latest) {
            await db.saveBranch(withNotice(latest, {
              text: [
                started.length ? `Started automatically: ${started.join(', ')}.` : '',
                held.length ? `Waiting for you: ${held.join('; ')}.` : '',
              ].filter(Boolean).join(' '),
            }));
          }
          console.log(`[chat] auto-accept started ${started.length}, held ${held.length}`);
        }
      };

      await settleProposals();

      /**
       * Start the proposals that are routine, once the personas are settled.
       *
       * Deliberately AFTER the assignment retry above: the policy refuses a leaf with no persona,
       * so running this first would hold every leaf the retry was about to fix.
       *
       * What is held is written into the transcript with its reason. A proposal that silently did
       * not start is indistinguishable from one the planner never made — which is the failure this
       * whole feature exists to fix, and it would be perverse to reintroduce it here.
       */

      /**
       * Out of tool rounds and still asking for more — so make it answer.
       *
       * Measured on a real conversation: four rounds, every one `finish_reason: tool_calls`, every
       * one zero characters of content. web_search returned five hits, fetch_web_page returned
       * pages whose stripped HTML held no usable figure, and the model simply searched again. The
       * loop then exited with a call still pending and the response ended having streamed NOTHING.
       * From the outside that is a chat that stops mid-thought for no stated reason.
       *
       * The final pass offers no tools at all, which is what makes it terminal — a nudge with the
       * tools still attached is just a fifth round. It says plainly that the budget is spent, so
       * the model reports what it found and what it could not confirm rather than inventing the
       * part it never reached.
       */
      if (calls.length > 0 && branchId) {
        sendFrame(res, { interruptedReason: `Used all ${MAX_TOOL_ROUNDS} research steps — answering with what was found.` });
        /**
         * Say WHICH calls were dropped, not just that the budget ran out.
         *
         * The calls in `calls` at this point were never executed, and the model does not know that
         * — it wrote them and moved on. Observed: a turn ended having reported that it attached a
         * project and set the acceptance plan, and neither call had run. Naming them is the
         * difference between the model correcting itself next turn and confidently claiming work
         * that never happened.
         */
        const dropped = [...new Set(calls.map((c) => c.name))].join(', ');
        conversation.push({
          role: 'user',
          content:
            'You have used all available research steps. These calls were NOT executed and did not '
            + `happen: ${dropped}. Answer now with what you found, say plainly that those were not `
            + 'done, and do not claim otherwise.',
        });
        const finalPass = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
          body: JSON.stringify(turnRequest(conversation, {
            stream: true,
            /**
           * Fitted to what the window has left, not asked for flat.
           *
           * The engine allocates prompt + max_tokens up front and refuses the job if the pair does
           * not fit — `Job requires 136 pages (only 128 available)`, which is 34,816 against a
           * 32,768 window. The agent loop was fixed for exactly this and the chat route never was,
           * so a plan turn with a long system prompt was refused before generating a single token.
           */
          maxTokens: fittedMaxTokens(rest.max_tokens ?? strategy.maxTokens, JSON.stringify(outboundMessages).length),
            reasoningEffort: rest.reasoning_effort ?? strategy.reasoningEffort,
            extra: { stream_options: { include_usage: true } },
          })),
          signal: upstreamAbort.signal,
        });
        if (finalPass.ok && finalPass.body) await pump(finalPass.body);
      }

      // Automatic Continuation Pass: if the response ran out of tokens mid-thought (finish_reason === 'length'),
      // automatically send a seamless continuation pass so the model finishes its answer completely.
      if (finishScanner.result() === 'length' && calls.length === 0) {
        sendFrame(res, { interruptedReason: 'Completion token cap reached (finish_reason: length) — auto-continuing...' });
        const partialAnswer = content?.result() ?? '';
        const continuationMessages: any[] = [
          ...outboundMessages,
          { role: 'assistant', content: partialAnswer },
          { role: 'user', content: 'Continue your response from exactly where you left off.' },
        ];
        const continuationPass = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify(turnRequest(continuationMessages, {
            stream: true,
            maxTokens: strategy.maxTokens,
            reasoningEffort: strategy.reasoningEffort,
            extra: {
              max_completion_tokens: strategy.maxTokens,
              stream_options: { include_usage: true },
            },
          })),
          signal: upstreamAbort.signal,
        });
        if (continuationPass.ok && continuationPass.body) {
          await pump(continuationPass.body);
        }
      }

      // Two-Stage Reasoning Architecture: If the model spent its generation on an inner monologue
      // without outputting final response prose, automatically trigger Stage 2 to stream the answer.
      const proseResult = (content?.result() ?? '').trim();
      if (!wasInterrupted && calls.length === 0 && !proseResult) {
        const monologueText = reasoningScanner.result() || featureExtractor.getText();
        if (monologueText && monologueText.length > 20) {
          const stage2Messages: any[] = [
            ...outboundMessages,
            { role: 'assistant', content: monologueText },
            { role: 'user', content: 'Based on your thoughts above, now state your concise final answer directly to the user.' },
          ];
          const stage2Pass = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
            },
            body: JSON.stringify(turnRequest(stage2Messages, {
              stream: true,
              maxTokens: strategy.maxTokens,
              reasoningEffort: strategy.reasoningEffort,
              extra: {
                max_completion_tokens: strategy.maxTokens,
                stream_options: { include_usage: true },
              },
            })),
            signal: upstreamAbort.signal,
          });
          if (stage2Pass.ok && stage2Pass.body) {
            await pump(stage2Pass.body);
          }
        }
      }

      res.end();

      // Update system-wide model thinking profile in MongoDB based on turn outcome
      try {
        const finalFeatures = featureExtractor.extract();
        const outcome = wasInterrupted ? 'failure' : 'success';
        const updatedProfile = updateModelProfile(globalProfile, targetModelId, finalFeatures, outcome);
        await db.saveModelThinkingProfile?.(updatedProfile);
      } catch {
        // Non-fatal training profile save error
      }

      // Proposals are created after the stream closes, from the assistant's CONTENT only —
      // never its reasoning, which routinely contains draft JSON the model then discarded.
      if (content && branchId) {
        try {
          const reply = content.result();

          /**
           * Persist the turn.
           *
           * Server-side rather than a client PATCH: a closed tab or a crashed browser would
           * otherwise lose the exchange that was just paid for. The branch is created on demand so
           * a conversation does not need to be declared before it starts.
           */
          try {
            const existing = (await db.getBranches()).find((b) => b.id === branchId && b.ownerId === (req as any).user.id);
            const userText = String(messages[lastIndex]?.content ?? '');
            const now = new Date().toISOString();
            const cleanReply = reply.includes('<think>')
              ? reply.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim() || reply
              : reply;
            /**
             * Reasoning is persisted alongside the reply.
             *
             * `BranchMessage.reasoning` has existed since branches did — "kept separately so it can
             * be collapsed, and dropped first when trimming" — and nothing ever wrote it. So the
             * deliberation was visible while the tab was open and gone the moment you navigated
             * away, because the only copy lived in the browser.
             *
             * Stored second to `content` and trimmed first, which is what the field was designed
             * for: it is the part you can afford to lose.
             */
            const thinking = reasoningScanner.result().trim();
            const turns: BranchMessage[] = [
              { role: 'user', content: userText },
              { role: 'assistant', content: cleanReply, ...(thinking ? { reasoning: thinking } : {}) },
            ];
            /**
             * Spread `existing` rather than naming the fields.
             *
             * `db.saveBranch` is a full replace, so every field not listed here was being DELETED
             * on every turn. That silently ate `acceptance` — the model called `set_acceptance`
             * during the turn, the tool wrote it, and this save immediately overwrote the branch
             * without it. Verified live: the sibling `set_leaf_project` call in the same turn stuck,
             * because it writes a LEAF.
             *
             * Fourth time this shape of bug has appeared here (saveDeploymentInfo's allowlist,
             * `dependsOn`, `expects`, and now this), which is why the fields below are the ones this
             * block genuinely owns and everything else rides on the spread.
             */
            await db.saveBranch({
              ...existing,
              id: String(branchId),
              ownerId: (req as any).user.id,
              // Named from the first message only — renaming is explicit, and re-deriving on every
              // turn would rewrite a title the user had chosen.
              title: existing?.title ?? deriveBranchTitle(userText),
              messages: trimTranscript([...(existing?.messages ?? []), ...turns]),
              createdAt: existing?.createdAt ?? now,
              updatedAt: now,
            });
          } catch (err: any) {
            // Losing the transcript must not fail a reply the user already received.
            console.warn(`[chat] could not persist transcript for branch ${branchId}: ${err.message}`);
          }

          /**
           * Extraction path. The conversation model reasons — which is what makes it good to talk
           * to and unreliable at emitting a format (measured at roughly one success in eight) — so
           * the structured job goes to a small non-reasoning model with a schema.
           *
           * Only for an explicit /plan for now: it is a second inference call, and running it on
           * every reply needs latency measured rather than assumed.
           */
          let extracted: Awaited<ReturnType<typeof extractViaModel>> | undefined;
          if (extracting && !proposedViaTools) {
            // Falls back to the CONVERSATION model, which is safe now that extraction disables
            // thinking per-request. The earlier refusal to fall back was because a reasoning model
            // cannot hold a format — with thinking off it can, measured at 3/3 against 1-in-8.
            // A separately configured extractor still wins, for a model that cannot disable it.
            const extractor =
              (await modelService.resolveExtractor((req as any).user.id).catch(() => undefined)) ??
              { provider, baseUrl, ...(apiKey ? { apiKey } : {}) };
            extracted = await extractViaModel(extractor, [...messages.slice(0, lastIndex), { role: 'assistant', content: reply }]);
          }
          // Distinguish "nothing worth proposing" from "the model never got to answer". The
          // second is a real failure that otherwise looks identical to the first.
          // Only worth flagging for an explicit /plan: an ordinary reply legitimately has no
          // content only when something went wrong, but that is the streaming path's concern.
          if (explicitPlan && !reply.trim()) {
            console.warn(`[chat] /plan produced no content for branch ${branchId} — the reply was likely consumed by reasoning before reaching an answer; raise max_tokens`);
          }
          // Extractor first when it produced anything; otherwise fall back to parsing the
          // conversation model's own reply, which works occasionally and beats nothing.
          /**
           * Nothing to extract once the tools have run.
           *
           * These are two paths to the same outcome and they were both live on every `auto` turn
           * with a branch: the model called `propose_leaf`, then its own prose summary — "I've
           * proposed 5 leaves. Here is the plan: 1. … 2. …" — was parsed into five MORE. Measured
           * live: ten leaves on one branch, the same five titles twice, and a second approval
           * prompt for work that was already running.
           *
           * The tools win because they are the deliberate path: a model that called them has said
           * exactly what it wants, while the prose is a report of having done so.
           */
          /**
           * Prose proposals the tools did NOT already cover.
           *
           * These two paths were treated as exclusive: any `propose_leaf` call discarded the whole
           * prose block, on the reasoning that prose is a REPORT of what the tools did. That holds
           * when the model uses one path. It does not when it mixes them.
           *
           * Measured: a planning turn called propose_leaf twice, wrote FOUR leaves in its json
           * block, and produced one leaf. Three stages of a four-stage plan were silently dropped,
           * and nothing anywhere said so.
           *
           * Matched on title rather than trusting either path: a prose entry describing a leaf the
           * tools already made is a duplicate and must not be created twice, while one naming work
           * no tool call covered is a stage that would otherwise be lost.
           */
          const fromProse = extracted?.length ? extracted : extractProposals(reply);
          // This user's leaves, not every leaf on the instance: another tenant's title has no
          // business suppressing a proposal here, and getLeaves() is unscoped.
          const already = (await ownedLeaves((req as any).user.id))
            .filter((l) => l.branchId === String(branchId))
            .map((l) => l.title);
          const proposals = proposedViaTools ? newProposals(fromProse, already) : newProposals(fromProse, []);
          if (proposedViaTools && proposals.length) {
            console.log(`[chat] branch ${branchId}: ${proposals.length} prose proposal(s) the tool calls did not cover`);
          }
          const now = new Date().toISOString();

          /**
           * The name the planner chose for the service this work produces.
           *
           * Saved on the TREE rather than a leaf: it outlives any one conversation and is what
           * every tool the service exposes gets prefixed with. Without it the name falls back to
           * the tree's own, which is a heading rather than a prefix — "GitHub API MCP" becomes
           * `github-api-mcp__` where the planner asked for `gh__`.
           *
           * Only when the planner actually said something usable, and never overwriting a name
           * already set: renaming a live service would change every tool name under it.
           */
          const declaredName = extractServiceName(reply);
          if (declaredName && branchId) {
            const branchRecord = (await ownedBranches((req as any).user.id)).find((b) => b.id === branchId);
            const tree = branchRecord?.treeId
              ? (await ownedTrees((req as any).user.id)).find((t) => t.id === branchRecord.treeId)
              : undefined;
            if (tree && !tree.serviceName) {
              /**
               * A name someone else already owns means this is the SAME service.
               *
               * `serviceName` is what a service's tools are prefixed with and what a persona names
               * to reach it, so two trees declaring one name are two conversations about one
               * service. Observed: a second run correctly found `github-mcp` running, said "no need
               * to rebuild it", and still built in a new repository — because knowing a project id
               * in prose is not attaching it, and the model never called `set_leaf_project`. That
               * produced a second deployment under the same name, which then had to be worked
               * around in three separate readers.
               *
               * Adopting rather than refusing: "that name is taken" would make the user rename it
               * to `github-mcp-2`, which is the collision with extra steps.
               */
              const claim = claimService(declaredName, tree, await ownedTrees((req as any).user.id));
              const adopted = claim.adoptProjectId
                ? withProject({ ...tree, serviceName: declaredName, updatedAt: now }, claim.adoptProjectId)
                : { ...tree, serviceName: declaredName, updatedAt: now };
              await db.saveTree(adopted);
              console.log(
                `[chat] tree ${tree.id}: service named "${declaredName}" by the planner`
                + (claim.adoptProjectId ? ` — adopting the repository of "${claim.ownedBy?.treeName}"` : ''),
              );
              // Said out loud: a silent repoint is how the work ends up somewhere nobody expected.
              const text = claimNotice(declaredName, claim);
              if (text) {
                const fresh = (await db.getBranches()).find((b) => b.id === String(branchId));
                if (fresh) await db.saveBranch(withNotice(fresh, { text }));
              }
            }
          }
          /**
           * Resolved once for the batch, against this user's own personas.
           *
           * A name the model invented resolves to nobody and the leaf is created unassigned — the
           * same outcome as before this field existed, and still recoverable. Refusing the leaf
           * over a spelling mistake would trade real work for a typo.
           */
          const myPersonas = await ownedPersonas((req as any).user.id);
          const myProjects = await projectRepoService.listForOwner((req as any).user.id);
          for (const proposal of proposals) {
            const assigned = resolvePersonaNamed(proposal.persona, myPersonas);
            if (proposal.persona && !assigned) {
              console.warn(`[chat] branch ${branchId}: no persona named "${proposal.persona}" for "${proposal.title}"`);
            }
            await db.saveLeaf({
              id: uuidv4(),
              ownerId: (req as any).user.id,
              branchId: String(branchId),
              title: proposal.title,
              ...(proposal.body ? { body: proposal.body } : {}),
              ...(assigned ? { personaId: assigned.id } : {}),
              // Without this the leaf has no tools for the service the plan told it to call.
              ...(proposal.mcp?.length ? { mcp: proposal.mcp } : {}),
              // Owner-checked: a project id names a repository, and this arrives from model output.
              ...(proposal.projectId && myProjects.some((p) => p.id === proposal.projectId)
                ? { projectId: proposal.projectId }
                : {}),
              column: 'todo',
              // Proposed, always: the model suggests, a human accepts. Nothing runs or spends here.
              status: 'proposed',
              depth: 0,
              blocking: true,
              createdAt: now,
              updatedAt: now,
            });
          }
          /**
           * Read the plan back before anyone commits to it.
           *
           * The two plan-shaped things a person had to point out during a real end-to-end run —
           * five leaves with no ordering, and a dependency on a leaf that had been withdrawn — are
           * both mechanically detectable, and neither is something a user would know to look for.
           * Posted as a notice so it sits in the conversation next to the proposals it is about.
           *
           * Only when this turn actually proposed something: re-stating the same warnings on every
           * later turn is how a warning becomes wallpaper.
           */
          if (proposedViaTools || proposals.length) {
            const onBranch = (await ownedLeaves((req as any).user.id))
              .filter((l) => l.branchId === String(branchId));
            const declared = (await db.getBranches()).find((b) => b.id === String(branchId))?.acceptance;
            /**
             * Two leaves that look like one job get REPORTED, never dropped.
             *
             * Lexical similarity ranks the real observed duplicate below two leaves that must both
             * exist (lib/proposal-merge.ts has the numbers), so acting on it would delete stages of
             * real plans. The reviewer already accepts every leaf by hand and already caught this
             * one unaided — the notice puts the pair in front of them instead of guessing.
             */
            const warnings = [
              planNotice(reviewPlan(onBranch, usableAcceptancePlan(declared).length)),
              duplicateNotice(suspectedDuplicates(onBranch.map((l) => l.title))),
            ].filter(Boolean).join('\n\n');
            if (warnings) {
              const fresh = (await db.getBranches()).find((b) => b.id === String(branchId));
              if (fresh) await db.saveBranch(withNotice(fresh, { text: warnings }));
            }
          }

          /**
           * Extracted proposals get the same treatment as proposed ones.
           *
           * They are leaves either way. Only the tool path settled them before, so a plan the model
           * wrote as prose produced leaves that nothing assigned a persona to and nothing started —
           * and which then could not be accepted at all, since a leaf with no persona has no
           * repository. Measured on a real run: two extracted leaves, one unassigned, both stuck.
           */
          if (proposals.length) await settleProposals();
        } catch (err: any) {
          // A parsing failure must never fail a reply the user already received.
          console.warn(`[chat] could not record proposals for branch ${branchId}: ${err.message}`);
        }
      }

      // Recorded after the response is closed: metering must never delay the user's tokens, and a
      // failure to record must never fail a generation that already succeeded.
      const used = scanner.result();
      if (used && leafId) {
        try {
          const leaf = (await db.getLeaves()).find((c) => c.id === leafId && c.ownerId === (req as any).user.id);
          if (leaf) {
            await db.saveLeaf({
              ...leaf,
              usage: { ...leaf.usage, tokens: (leaf.usage?.tokens ?? 0) + used.totalTokens },
              updatedAt: new Date().toISOString(),
            });
          }
        } catch (err: any) {
          console.warn(`[chat] could not record ${used.totalTokens} tokens against leaf ${leafId}: ${err.message}`);
        }
      }
    } catch (err: any) {
      if (upstreamAbort.signal.aborted) return; // client hung up; nothing to report
      if (!res.headersSent) return res.status(502).json({ error: err.message });
      res.end();
    }
  });

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

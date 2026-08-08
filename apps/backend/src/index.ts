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
import { ContentScanner, UsageScanner } from './lib/token-usage.js';
import { AMBIENT_PROPOSAL_PROMPT, MAX_PROPOSALS_PER_REPLY, isChatMode, type ChatMode, PLAN_MODE_MAX_TOKENS, PLAN_SYSTEM_PROMPT, extractProposals, parseChatCommand, type LeafProposal } from './lib/plan-mode.js';
import { buildOutboundMessages } from './lib/leaf-context.js';
import { isWorkspaceLanguage, imageForLanguage, WORKSPACE_IMAGES } from './lib/workspace-spec.js';
import { conversationSampling, TOOL_DISCIPLINE_PROMPT } from './lib/sampling.js';
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
} from './lib/experiment-authoring.js';
import { AuthoringService, acceptedTasks } from './services/AuthoringService.js';
import { WorkbenchService } from './services/WorkbenchService.js';
import { buildPromotion, supersede, revertTo } from './lib/harness-profile.js';
import { buildConfigExport, parseConfigExport } from './lib/config-export.js';
import { validateOverrides, loopKeys } from './lib/tunables.js';
import { runLeafTool as runLeafToolShared } from './lib/leaf-tool-runner.js';
import { resolveWebTools } from './lib/web-tools-resolver.js';
import { resolveConfig, validatePersona, type Persona } from './lib/personas.js';
import { ExperimentService } from './services/ExperimentService.js';
import {
  expandAxes, validateExperiment, plannedRuns, experimentTasks, taskIdOf, summariseExperiment, normaliseExperiment, latestResults,
  MAX_REPEATS, MAX_TASK_CHARS, MAX_TASKS, MAX_TASK_FILES, MAX_TASK_FILE_CHARS,
  type Experiment, type ExperimentTask,
} from './lib/experiments.js';
import { EXTRACTION_SCHEMA, EXTRACTION_SYSTEM_PROMPT, EXTRACTION_TEMPLATE_VARS, buildExtractionPrompt, parseExtractionResult } from './lib/extraction.js';
import { LEAF_TOOLS, MAX_TOOL_ROUNDS, ToolCallScanner, type ToolCall, detailLeaf, parseToolArguments, summariseLeaf } from './lib/leaf-tools.js';
import { deriveBranchTitle, trimTranscript, type Branch, type BranchMessage, LEAF_COLUMNS, isLeafColumn, aggregateUsage, budgetExceeded, canAddChild, childrenOf, deriveLeafStatus, rootLeaf, subtreeOf, blockedBy, wouldCycle, type Leaf } from './lib/leaves.js';
import { generateSshKeypair } from './lib/ssh-keypair.js';
import { getToolRepository } from './lib/tool-repository.js';
import type { MemoryItem } from './lib/memory-store.js';

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

  function parseCookie(cookieHeader: string | undefined, name: string): string | undefined {
    if (!cookieHeader) return undefined;
    const cookies = cookieHeader.split(';').map(c => c.trim());
    for (const cookie of cookies) {
      const [k, v] = cookie.split('=');
      if (k === name) return v;
    }
    return undefined;
  }

  const getCookie = (req: express.Request, name: string) => parseCookie(req.headers.cookie, name);

  /**
   * Resolves the signed-in user from a session cookie. Shared by requireAuth and the Socket.IO
   * handshake so both accept exactly the same credential.
   */
  async function userFromSessionCookie(cookieHeader: string | undefined): Promise<UserMetadata | undefined> {
    const token = parseCookie(cookieHeader, 'session');
    if (!token) return undefined;
    const decoded = verifyJWT(token, JWT_SECRET);
    if (!decoded || !decoded.userId) return undefined;
    return await db.getUserById(decoded.userId);
  }

  const requireAuth = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const publicPaths = [
      '/auth/login',
      '/auth/register',
      '/auth/2fa/verify',
      '/auth/github',
      '/auth/google',
      '/auth/github/callback',
      '/auth/google/callback',
    ];
    if (publicPaths.includes(req.path)) {
      return next();
    }
    if (process.env.IS_E2E === 'true') {
      const users = await db.getUsers();
      const mockUser = users[0] || {
        id: 'test-user-id',
        email: 'test@example.com',
        twoFactorEnabled: false,
        emailVerified: true,
        createdAt: new Date().toISOString(),
      };
      (req as any).user = mockUser;
      return next();
    }

    if (!getCookie(req, 'session')) {
      return res.status(401).json({ error: 'Unauthorized: Session missing' });
    }
    const user = await userFromSessionCookie(req.headers.cookie);
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized: Session invalid or expired' });
    }
    (req as any).user = user;
    next();
  };

  app.use('/api', requireAuth);

  const requireAdmin = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!(req as any).user?.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  };

  // This system can spend real money via cloud APIs, so account creation is invite-gated —
  // except the very first user ever, who bootstraps the instance and becomes admin (mirrors
  // migrateLegacyOwnership's backfill logic for pre-existing installs). Consumes the invite
  // (stamps usedBy/usedAt) only on success, so a rejected registration doesn't burn the code.
  async function checkAndConsumeInvite(code: string | undefined, newUserId: string, isFirstUser: boolean): Promise<string | null> {
    if (isFirstUser) return null;
    if (!code) return 'An invite code is required to create an account';
    const invites = await db.getInvites();
    const invite = invites.find((i) => i.code === code);
    if (!invite) return 'Invalid invite code';
    if (invite.usedBy) return 'This invite code has already been used';
    await db.saveInvite({ ...invite, usedBy: newUserId, usedAt: new Date().toISOString() });
    return null;
  }

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
      const owned = project?.ownerId ? project.ownerId === user.id : user.isAdmin === true;
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
  const secureCookies = PUBLIC_URL.startsWith('https://');
  const sessionCookieOptions = {
    httpOnly: true,
    secure: secureCookies,
    sameSite: 'lax' as const,
  };
  const setSessionCookie = (res: express.Response, token: string) => {
    res.cookie('session', token, { ...sessionCookieOptions, maxAge: 24 * 60 * 60 * 1000 });
  };

  app.post('/api/auth/register', async (req, res) => {
    try {
      let { email, password, inviteCode } = req.body;
      if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
      }
      // getUserByEmail (used by login, 2FA, OAuth linking, etc.) normalizes with
      // .trim().toLowerCase() before querying — pre-existing, found live while testing this
      // session's per-user isolation work: registering with any capital letter in the email
      // (e.g. "isoA@example.com") stored it as-is, so login's normalized lookup could never find
      // it again ("Invalid email or password" despite a correct password). Normalizing here too
      // keeps every path consistent instead of only patching the read side.
      email = email.trim().toLowerCase();
      const existing = await db.getUserByEmail(email);
      if (existing) {
        return res.status(400).json({ error: 'User already exists' });
      }

      const isFirstUser = (await db.getUsers()).length === 0;
      const userId = uuidv4();
      const inviteError = await checkAndConsumeInvite(inviteCode, userId, isFirstUser);
      if (inviteError) {
        return res.status(403).json({ error: inviteError });
      }

      const passHash = await hashPassword(password);
      const user = {
        id: userId,
        email,
        passwordHash: passHash,
        twoFactorEnabled: false,
        emailVerified: true,
        createdAt: new Date().toISOString(),
        ...(isFirstUser ? { isAdmin: true } : {}),
      };
      await db.saveUser(user);
      res.json({ success: true, message: 'User registered successfully' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/auth/login', async (req, res) => {
    try {
      const { email, password } = req.body;
      if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
      }
      const user = await db.getUserByEmail(email);
      if (!user || !user.passwordHash) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }
      const match = await verifyPassword(password, user.passwordHash);
      if (!match) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      if (user.twoFactorEnabled) {
        const code = authService.create2FAChallenge(user.id);
        await authService.send2FACode(user, code);
        return res.json({ twoFactorRequired: true, userId: user.id });
      }

      const token = signJWT({ userId: user.id, email: user.email }, JWT_SECRET, 24 * 60 * 60);
      setSessionCookie(res, token);
      res.json({
        success: true,
        user: {
          id: user.id,
          email: user.email,
          twoFactorEnabled: user.twoFactorEnabled,
          isAdmin: user.isAdmin === true,
        },
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/auth/2fa/verify', async (req, res) => {
    try {
      const { userId, code } = req.body;
      if (!userId || !code) {
        return res.status(400).json({ error: 'User ID and OTP code are required' });
      }
      const user = await db.getUserById(userId);
      if (!user) {
        return res.status(400).json({ error: 'User not found' });
      }

      const ok = authService.verify2FAChallenge(userId, code);
      if (!ok) {
        return res.status(400).json({ error: 'Invalid or expired 2FA code' });
      }

      const token = signJWT({ userId: user.id, email: user.email }, JWT_SECRET, 24 * 60 * 60);
      setSessionCookie(res, token);
      res.json({
        success: true,
        user: {
          id: user.id,
          email: user.email,
          twoFactorEnabled: user.twoFactorEnabled,
          isAdmin: user.isAdmin === true,
        },
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/auth/logout', (req, res) => {
    res.clearCookie('session', sessionCookieOptions);
    res.json({ success: true });
  });

  app.get('/api/auth/me', (req, res) => {
    const user = (req as any).user;
    if (!user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    res.json({
      id: user.id,
      email: user.email,
      twoFactorEnabled: user.twoFactorEnabled,
      twoFactorPhone: user.twoFactorPhone,
      twoFactorPreferredMethod: user.twoFactorPreferredMethod,
      emailVerified: user.emailVerified,
      createdAt: user.createdAt,
      isAdmin: user.isAdmin === true,
    });
  });

  app.post('/api/auth/2fa/settings', async (req, res) => {
    try {
      const { enabled, phone, preferredMethod } = req.body;
      const user = (req as any).user;
      if (!user) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      user.twoFactorEnabled = !!enabled;
      if (phone !== undefined) user.twoFactorPhone = phone;
      if (preferredMethod !== undefined) user.twoFactorPreferredMethod = preferredMethod;

      await db.saveUser(user);
      res.json({
        id: user.id,
        email: user.email,
        twoFactorEnabled: user.twoFactorEnabled,
        twoFactorPhone: user.twoFactorPhone,
        twoFactorPreferredMethod: user.twoFactorPreferredMethod,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

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
  const mockOAuthAllowed = (): boolean => process.env.NODE_ENV !== 'production';

  app.get('/api/auth/github', (req, res) => {
    // Carries any invite code through the OAuth roundtrip via `state` — GitHub/Google echo it
    // back verbatim on the callback — so a brand-new account created via social login is
    // invite-gated exactly like native registration, not a silent bypass of it.
    const invite = typeof req.query.invite === 'string' ? req.query.invite : '';
    const githubId = process.env.GITHUB_CLIENT_ID;
    if (!githubId) {
      if (!mockOAuthAllowed()) {
        return res.status(501).json({ error: 'GitHub sign-in is not configured on this server.' });
      }
      return res.redirect(`${PUBLIC_URL}/api/auth/github/callback?code=mock-github-code&state=${encodeURIComponent(invite)}`);
    }
    const redirectUri = encodeURIComponent(`${PUBLIC_URL}/api/auth/github/callback`);
    res.redirect(`https://github.com/login/oauth/authorize?client_id=${githubId}&redirect_uri=${redirectUri}&scope=user:email&state=${encodeURIComponent(invite)}`);
  });

  app.get('/api/auth/github/callback', async (req, res) => {
    try {
      const { code, state } = req.query;
      let email = 'mock-github-user@example.com';
      let idStr = 'github-mock-id';

      const githubId = process.env.GITHUB_CLIENT_ID;
      const githubSecret = process.env.GITHUB_CLIENT_SECRET;

      // The magic code is attacker-controlled input, so it can only be honoured where the mock
      // flow is permitted at all. Previously `code !== 'mock-github-code'` was the ONLY guard, which
      // meant requesting this callback directly with that value skipped the token exchange and
      // logged the caller in as the mock user even on a fully configured server.
      const mockRequested = code === 'mock-github-code';
      if (mockRequested && !mockOAuthAllowed()) {
        return res.status(403).json({ error: 'Mock sign-in is disabled on this server.' });
      }
      if (!mockRequested && !(githubId && githubSecret)) {
        return res.status(501).json({ error: 'Github sign-in is not configured on this server.' });
      }

      if (githubId && githubSecret && !mockRequested) {
        const tokenRes = await axios.post('https://github.com/login/oauth/access_token', {
          client_id: githubId,
          client_secret: githubSecret,
          code,
        }, { headers: { Accept: 'application/json' } });
        
        const accessToken = tokenRes.data.access_token;
        if (!accessToken) throw new Error('No access token returned from GitHub');

        const userRes = await axios.get('https://api.github.com/user', {
          headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': 'provisioning-platform' },
        });

        const emailRes = await axios.get('https://api.github.com/user/emails', {
          headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': 'provisioning-platform' },
        });

        const primaryEmailObj = emailRes.data.find((e: any) => e.primary) || emailRes.data[0];
        email = primaryEmailObj?.email || `${userRes.data.login}@github.com`;
        idStr = String(userRes.data.id);
      }

      let user = await db.getUserByEmail(email);
      if (!user) {
        const isFirstUser = (await db.getUsers()).length === 0;
        const userId = uuidv4();
        const inviteError = await checkAndConsumeInvite(typeof state === 'string' ? state : undefined, userId, isFirstUser);
        if (inviteError) {
          return res.redirect(`${APP_URL}/?authError=${encodeURIComponent(inviteError)}`);
        }
        user = {
          id: userId,
          email,
          githubId: idStr,
          twoFactorEnabled: false,
          emailVerified: true,
          createdAt: new Date().toISOString(),
          ...(isFirstUser ? { isAdmin: true } : {}),
        };
        await db.saveUser(user);
      } else if (!user.githubId) {
        user.githubId = idStr;
        await db.saveUser(user);
      }

      const token = signJWT({ userId: user.id, email: user.email }, JWT_SECRET, 24 * 60 * 60);
      setSessionCookie(res, token);
      res.redirect(`${APP_URL}/`);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /** ── CLUSTER PROXY — dashboard access ── */

  const PROXY_SERVICES = ['prometheus', 'grafana', 'traefik', 'gitea', 'alertmanager'] as const;

  // Chart-generated admin password (constructs/monitoring.ts's kube-prometheus-stack release) —
  // only ever used server-side to log in on the browser's behalf (see the auto-login block
  // below), never returned to a client.
  async function getGrafanaAdminCredentials(kubeconfigPath: string): Promise<{ username: string; password: string }> {
    const raw = await infraService.runKubectl(
      ['get', 'secret', 'kube-prometheus-stack-grafana', '-n', 'monitoring', '-o', 'jsonpath={.data.admin-password}'],
      kubeconfigPath,
    );
    return { username: 'admin', password: Buffer.from(raw.trim(), 'base64').toString('utf8') };
  }

  for (const serviceKey of PROXY_SERVICES) {
    app.get(`/api/clusters/:id/proxy/${serviceKey}`, async (req, res) => {
      try {
        const clusterId = req.params.id;
        const cluster = await clusterService.getById(clusterId, (req as any).user.id);
        if (!cluster) return res.status(404).json({ error: 'Cluster not found' });

        const kubeconfigPath = await clusterService.getKubeconfigPath(cluster);
        const targetUrl = await clusterProxyService.ensurePortForward(clusterId, serviceKey, kubeconfigPath);

        // Gitea sends X-Frame-Options: SAMEORIGIN unconditionally — confirmed live that even
        // explicitly clearing gitea.config.security.X_FRAME_OPTIONS via Helm doesn't change the
        // emitted header (an empty value isn't treated as "disable", it falls back to the
        // compiled-in default). Grafana defaults to X-Frame-Options: deny (its own
        // allow_embedding setting off by default) — stricter still, blocks framing from any
        // origin including its own. Both would just render blank in a real browser's iframe.
        // A redirect sidesteps it for both — also arguably better UX for full standalone apps
        // like these vs. a genuinely embeddable dashboard like Prometheus/Traefik.
        if (serviceKey === 'gitea' || serviceKey === 'grafana') {
          // Auto-login: relay a real session cookie from the service's own login flow (see
          // ClusterProxyService.getAutoLoginCookies) so the user lands already signed in — the
          // password is fetched/used server-side only and never reaches the browser. Best-effort:
          // if this ever fails (chart password rotated, service briefly unreachable, etc.), fall
          // straight through to a plain redirect — the user just sees the normal login screen
          // instead of a broken proxy link.
          try {
            const credentials = serviceKey === 'gitea'
              ? await giteaService.getAdminCredentials()
              : await getGrafanaAdminCredentials(kubeconfigPath);
            const cookies = await clusterProxyService.getAutoLoginCookies(serviceKey, targetUrl, credentials);
            for (const cookie of cookies) res.append('Set-Cookie', cookie);
          } catch (err: any) {
            console.warn(`[proxy] Auto-login failed for ${serviceKey}: ${err.message} — falling back to manual login`);
          }
          return res.redirect(302, targetUrl);
        }

        res.setHeader('Content-Type', 'text/html');
        res.send(`<!DOCTYPE html><html><head><title>${serviceKey}</title></head><body style="margin:0"><iframe src="${targetUrl}" style="width:100%;height:100vh;border:none"></iframe></body></html>`);
      } catch (err: any) {
        res.status(502).json({ error: `Service unavailable: ${err.message}` });
      }
    });
  }

  app.get('/api/auth/google', (req, res) => {
    // See the matching comment on /api/auth/github: carries the invite code through via `state`.
    const invite = typeof req.query.invite === 'string' ? req.query.invite : '';
    const googleId = process.env.GOOGLE_CLIENT_ID;
    if (!googleId) {
      if (!mockOAuthAllowed()) {
        return res.status(501).json({ error: 'Google sign-in is not configured on this server.' });
      }
      return res.redirect(`${PUBLIC_URL}/api/auth/google/callback?code=mock-google-code&state=${encodeURIComponent(invite)}`);
    }
    const redirectUri = encodeURIComponent(`${PUBLIC_URL}/api/auth/google/callback`);
    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?client_id=${googleId}&redirect_uri=${redirectUri}&response_type=code&scope=email%20profile&state=${encodeURIComponent(invite)}`);
  });

  app.get('/api/auth/google/callback', async (req, res) => {
    try {
      const { code, state } = req.query;
      let email = 'mock-google-user@example.com';
      let idStr = 'google-mock-id';

      const googleId = process.env.GOOGLE_CLIENT_ID;
      const googleSecret = process.env.GOOGLE_CLIENT_SECRET;

      // The magic code is attacker-controlled input, so it can only be honoured where the mock
      // flow is permitted at all. Previously `code !== 'mock-google-code'` was the ONLY guard, which
      // meant requesting this callback directly with that value skipped the token exchange and
      // logged the caller in as the mock user even on a fully configured server.
      const mockRequested = code === 'mock-google-code';
      if (mockRequested && !mockOAuthAllowed()) {
        return res.status(403).json({ error: 'Mock sign-in is disabled on this server.' });
      }
      if (!mockRequested && !(googleId && googleSecret)) {
        return res.status(501).json({ error: 'Google sign-in is not configured on this server.' });
      }

      if (googleId && googleSecret && !mockRequested) {
        const tokenRes = await axios.post('https://oauth2.googleapis.com/token', {
          client_id: googleId,
          client_secret: googleSecret,
          code,
          grant_type: 'authorization_code',
          redirect_uri: `${PUBLIC_URL}/api/auth/google/callback`,
        });

        const accessToken = tokenRes.data.access_token;
        if (!accessToken) throw new Error('No access token returned from Google');

        const userRes = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
          headers: { Authorization: `Bearer ${accessToken}` },
        });

        email = userRes.data.email;
        idStr = String(userRes.data.id);
      }

      let user = await db.getUserByEmail(email);
      if (!user) {
        const isFirstUser = (await db.getUsers()).length === 0;
        const userId = uuidv4();
        const inviteError = await checkAndConsumeInvite(typeof state === 'string' ? state : undefined, userId, isFirstUser);
        if (inviteError) {
          return res.redirect(`${APP_URL}/?authError=${encodeURIComponent(inviteError)}`);
        }
        user = {
          id: userId,
          email,
          googleId: idStr,
          twoFactorEnabled: false,
          emailVerified: true,
          createdAt: new Date().toISOString(),
          ...(isFirstUser ? { isAdmin: true } : {}),
        };
        await db.saveUser(user);
      } else if (!user.googleId) {
        user.googleId = idStr;
        await db.saveUser(user);
      }

      const token = signJWT({ userId: user.id, email: user.email }, JWT_SECRET, 24 * 60 * 60);
      setSessionCookie(res, token);
      res.redirect(`${APP_URL}/`);
    } catch (err: any) {
      res.status(500).send(`Google OAuth callback failed: ${err.message}`);
    }
  });

  /** ── ADMIN — invites ── */

  app.get('/api/admin/invites', requireAdmin, async (req, res) => {
    res.json(await db.getInvites());
  });

  app.post('/api/admin/invites', requireAdmin, async (req, res) => {
    const code = crypto.randomBytes(4).toString('hex');
    const invite: InviteMetadata = {
      id: code,
      code,
      createdBy: (req as any).user.id,
      createdAt: new Date().toISOString(),
    };
    await db.saveInvite(invite);
    res.status(201).json(invite);
  });

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

  /**
   * What the UI needs to render a working join command, plus whether the mesh is usable at all.
   * `loginServer` is null on a local dev box (MESH_LOGIN_SERVER unset, Headscale's server_url
   * still localhost) — the UI must say so rather than printing a command that would tell the
   * user's machine to contact itself.
   */
  app.get('/api/mesh/config', async (_req, res) => {
    const loginServer = process.env.MESH_LOGIN_SERVER || null;
    res.json({
      loginServer,
      configured: Boolean(loginServer && !/localhost|127\.0\.0\.1/.test(loginServer)),
    });
  });

  app.get('/api/mesh/devices', async (req, res) => {
    try {
      res.json(await headscaleService.listUserDevices((req as any).user.id));
    } catch (err: any) {
      res.status(503).json({ error: `Mesh unavailable: ${err.message}` });
    }
  });

  app.post('/api/mesh/preauth-key', async (req, res) => {
    try {
      const reusable = req.body?.reusable === true;
      const expirySeconds = typeof req.body?.expirySeconds === 'number' ? req.body.expirySeconds : undefined;
      const key = await headscaleService.createPreAuthKey((req as any).user.id, { reusable, expirySeconds });
      res.status(201).json(key);
    } catch (err: any) {
      res.status(503).json({ error: `Mesh unavailable: ${err.message}` });
    }
  });

  app.delete('/api/mesh/devices/:nodeId', async (req, res) => {
    try {
      // Ownership: only revoke a node this user's own Headscale namespace actually owns —
      // listUserDevices() is already scoped to req.user.id, so a foreign nodeId simply won't
      // appear in it (the same 404-not-403 pattern used for clusters/deployments).
      const devices = await headscaleService.listUserDevices((req as any).user.id);
      if (!devices.some((d) => d.id === req.params.nodeId)) {
        return res.status(404).json({ error: 'Mesh device not found' });
      }
      await headscaleService.revokeDevice(req.params.nodeId);
      res.json({ success: true });
    } catch (err: any) {
      res.status(503).json({ error: `Mesh unavailable: ${err.message}` });
    }
  });

  /** ── CREDENTIALS ── */

  const VALID_PROVIDERS = ['aws', 'gcp', 'azure', 'do', 'hetzner', 'cloudflare', 'vultr', 'linode', 'scaleway', 'hostinger', 'contabo', 'huggingface', 'github', 'googledrive'] as const;

  /**
   * Live VPS plan/price search across providers — see VpsCatalogService for why this is queried
   * rather than hardcoded. Public catalogues (Linode, Vultr) always appear; Hetzner and
   * DigitalOcean appear once the requesting user has stored a token for them, and the `sources`
   * array explains any provider that's missing.
   */
  app.get('/api/vps-catalog', async (req, res) => {
    try {
      const q = req.query as Record<string, string | undefined>;
      const num = (v: string | undefined) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : undefined);
      const result = await vpsCatalogService.search((req as any).user.id, {
        ...(num(q.minRamGb) !== undefined ? { minRamGb: num(q.minRamGb)! } : {}),
        ...(num(q.maxRamGb) !== undefined ? { maxRamGb: num(q.maxRamGb)! } : {}),
        ...(num(q.minVcpu) !== undefined ? { minVcpu: num(q.minVcpu)! } : {}),
        ...(num(q.minDiskGb) !== undefined ? { minDiskGb: num(q.minDiskGb)! } : {}),
        ...(num(q.maxPriceMonthly) !== undefined ? { maxPriceMonthly: num(q.maxPriceMonthly)! } : {}),
        ...(q.location ? { location: q.location } : {}),
        ...(q.arch ? { arch: q.arch as any } : {}),
        ...(q.cpuType ? { cpuType: q.cpuType as any } : {}),
        ...(q.hasGpu === 'true' ? { hasGpu: true } : q.hasGpu === 'false' ? { hasGpu: false } : {}),
        ...(num(q.minGpuVramGb) !== undefined ? { minGpuVramGb: num(q.minGpuVramGb)! } : {}),
        ...(q.provider ? { provider: q.provider } : {}),
        ...(q.provisionableOnly === 'true' ? { provisionableOnly: true } : {}),
        ...(q.hourlyOnly === 'true' ? { hourlyOnly: true } : {}),
        ...(q.sort ? { sort: q.sort as any } : {}),
        ...(q.sortDir === 'asc' || q.sortDir === 'desc' ? { sortDir: q.sortDir } : {}),
        ...(num(q.limit) !== undefined ? { limit: num(q.limit)! } : {}),
      });
      res.json(result);
    } catch (err: any) {
      // search() is meant to absorb per-provider failures into `sources` and still return, so
      // reaching here means something structural broke. Logged with the stack because the response
      // body alone left no server-side trace of an empty catalogue.
      console.error('[vps-catalog] search failed:', err.stack ?? err.message);
      res.status(500).json({ error: err.message });
    }
  });

  /** Forces a re-fetch on the next search — backs the UI's Refresh button. */
  app.post('/api/vps-catalog/refresh', async (_req, res) => {
    vpsCatalogService.clearCache();
    res.json({ ok: true });
  });

  app.get('/api/credentials', async (req, res) => {
    try {
      const user = (req as any).user;
      const statuses = await credentialService.getConfiguredProviders(user.id);
      res.json({ providers: statuses });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/credentials/validate/:provider', async (req, res) => {
    try {
      const provider = req.params.provider as CloudProvider;
      if (!VALID_PROVIDERS.includes(provider)) {
        return res.status(400).json({ error: `Invalid provider: ${provider}` });
      }
      const user = (req as any).user;
      // googledrive's refresh token was never typed into the form (it came from the OAuth
      // callback) so there's nothing meaningful in req.body to validate — check the stored one.
      const result = provider === 'googledrive'
        ? await credentialService.testGoogleDriveConnection(user.id)
        : await credentialService.validateCredentials(provider, req.body);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ valid: false, error: err.message });
    }
  });

  app.get('/api/credentials/:provider', async (req, res) => {
    try {
      const provider = req.params.provider as CloudProvider;
      if (!VALID_PROVIDERS.includes(provider)) {
        return res.status(400).json({ error: `Invalid provider: ${provider}` });
      }
      const user = (req as any).user;
      const creds = await credentialService.getCredentials(user.id, provider);
      res.json({ provider, credentials: creds });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/credentials/:provider', async (req, res) => {
    try {
      const provider = req.params.provider as CloudProvider;
      if (!VALID_PROVIDERS.includes(provider)) {
        return res.status(400).json({ error: `Invalid provider: ${provider}` });
      }
      const user = (req as any).user;
      await credentialService.saveCredentials(user.id, provider, req.body);
      const updated = await credentialService.getCredentials(user.id, provider);
      res.json({ success: true, provider, credentials: updated });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/credentials/:provider', async (req, res) => {
    try {
      const provider = req.params.provider as CloudProvider;
      if (!VALID_PROVIDERS.includes(provider)) {
        return res.status(400).json({ error: `Invalid provider: ${provider}` });
      }
      const user = (req as any).user;
      await credentialService.deleteCredentials(user.id, provider);
      res.json({ success: true, provider });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /** ── GOOGLE DRIVE (backup destination) ──
   * Separate OAuth dance from /api/auth/google (login) — same GOOGLE_CLIENT_ID/SECRET app
   * registration can serve both as long as this callback URL is also added under "Authorized
   * redirect URIs" in Google Cloud Console, and the Drive API is enabled for that project.
   * scripts/backup-to-drive.sh picks these credentials up via generate-rclone-config.ts. */

  app.get('/api/credentials/googledrive/connect', (req, res) => {
    const googleId = process.env.GOOGLE_CLIENT_ID;
    if (!googleId) {
      return res.redirect(`${APP_URL}/?driveError=missing_client_id`);
    }
    const redirectUri = encodeURIComponent(`${PUBLIC_URL}/api/credentials/googledrive/callback`);
    // access_type=offline + prompt=consent: without both, Google only hands back a
    // refresh_token on a user's very first-ever consent for this app — reconnecting later
    // (e.g. after a Disconnect) would silently get an access-token-only response otherwise.
    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?client_id=${googleId}&redirect_uri=${redirectUri}&response_type=code&access_type=offline&prompt=consent&scope=${encodeURIComponent('https://www.googleapis.com/auth/drive.file')}`);
  });

  app.get('/api/credentials/googledrive/callback', async (req, res) => {
    try {
      const { code } = req.query;
      const googleId = process.env.GOOGLE_CLIENT_ID;
      const googleSecret = process.env.GOOGLE_CLIENT_SECRET;
      if (!googleId || !googleSecret) {
        return res.redirect(`${APP_URL}/?driveError=missing_client_id`);
      }

      const tokenRes = await axios.post('https://oauth2.googleapis.com/token', {
        client_id: googleId,
        client_secret: googleSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: `${PUBLIC_URL}/api/credentials/googledrive/callback`,
      });

      const refreshToken = tokenRes.data.refresh_token;
      const accessToken = tokenRes.data.access_token;
      if (!refreshToken) {
        // Happens if the user had already granted consent before and Google didn't re-issue a
        // refresh_token despite prompt=consent (rare, but possible with cached grants) — send
        // them to revoke access at myaccount.google.com/permissions and try again.
        return res.redirect(`${APP_URL}/?driveError=no_refresh_token`);
      }

      const aboutRes = await axios.get('https://www.googleapis.com/drive/v3/about?fields=user', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const email = aboutRes.data.user?.emailAddress || '';

      const user = (req as any).user;
      await credentialService.saveCredentials(user.id, 'googledrive', { refreshToken, email });
      res.redirect(`${APP_URL}/?driveConnected=1`);
    } catch (err: any) {
      res.redirect(`${APP_URL}/?driveError=${encodeURIComponent(err.message)}`);
    }
  });

  app.post('/api/backup/run', async (req, res) => {
    const script = path.join(__dirname, '../../../scripts/backup-to-drive.sh');
    const child = spawn('bash', [script], { cwd: path.join(__dirname, '../../..') });
    let output = '';
    child.stdout.on('data', (d) => { output += d.toString(); });
    child.stderr.on('data', (d) => { output += d.toString(); });
    child.on('close', (exitCode) => {
      res.json({ success: exitCode === 0, output });
    });
    child.on('error', (err) => {
      res.status(500).json({ success: false, output: output + `\n${err.message}` });
    });
  });

  /** ── CLUSTERS ── */

  app.get('/api/clusters', async (req, res) => res.json(await clusterService.getAll((req as any).user.id, io)));

  app.post('/api/clusters', async (req, res) => {
    try {
      // Checked here, synchronously, rather than inside the workflow: the name becomes a
      // TerraformStack id and a Kubernetes object name, so an invalid one fails deep inside a
      // CDKTF subprocess minutes later with "Cannot create TerraformStack with id ... It contains
      // a whitespace character" — after a VM may already have been created and billed.
      const nameCheck = validateClusterName(req.body.name);
      if (!nameCheck.ok) {
        return res.status(400).json({
          error: nameCheck.error,
          ...(nameCheck.suggestion ? { suggestion: nameCheck.suggestion } : {}),
        });
      }

      const remote = req.body.provider === 'remote'
        ? {
            host: req.body.remoteHost,
            username: req.body.remoteUsername,
            privateKey: req.body.remoteSshPrivateKey,
            ...(typeof req.body.remoteSshPort === 'number' ? { port: req.body.remoteSshPort } : {}),
            ...(typeof req.body.remoteK3sApiPort === 'number' ? { k3sApiPort: req.body.remoteK3sApiPort } : {}),
          }
        : undefined;
      if (remote && (!remote.host || !remote.username)) {
        return res.status(400).json({ error: 'remoteHost and remoteUsername are required for provider "remote"' });
      }

      // No private key supplied → generate the pair here and hand back only the PUBLIC half.
      //
      // The alternative, which this replaces, was asking the user to paste their own private key
      // into a textarea. That is the wrong direction for a hosted product: an invited user should
      // never surrender a credential to it, and a key that arrives this way is one we cannot
      // bound the scope of — it may well be their everyday key with access to everything else
      // they own. Generating here means the private half never leaves the server and the user
      // authorises exactly one key, for exactly this.
      //
      // The cluster is saved in 'awaiting-key' rather than provisioning immediately, because the
      // key is useless until they have actually installed it. Starting the workflow now would
      // burn all three attempts on Permission denied before they had a chance.
      if (remote && !remote.privateKey) {
        const pair = await generateSshKeypair(`nowrinkles-${req.body.name}`);
        const saved = await clusterService.createAwaitingKey({
          name: req.body.name,
          ownerId: (req as any).user.id,
          host: remote.host,
          username: remote.username,
          privateKey: pair.privateKey,
          ...(remote.port !== undefined ? { port: remote.port } : {}),
        });
        return res.status(201).json({
          id: saved.id,
          status: 'awaiting-key',
          publicKey: pair.publicKey.trim(),
          message: 'Authorise this key on the machine, then start provisioning.',
        });
      }
      const hetzner = req.body.provider === 'hetzner'
        ? {
            ...(req.body.hetznerServerType ? { serverType: String(req.body.hetznerServerType) } : {}),
            ...(req.body.hetznerLocation ? { location: String(req.body.hetznerLocation) } : {}),
            ...(req.body.hetznerImage ? { image: String(req.body.hetznerImage) } : {}),
          }
        : undefined;
      const info = await temporalBridge.provision(req.body.name, req.body.provider, (req as any).user.id, remote, hetzner);
      res.status(202).json({
        message: 'Provisioning started',
        clusterName: req.body.name,
        provider: req.body.provider,
        id: info.resourceId,
        workflowId: info.id,
        state: 'running',
      });
    } catch (err: any) {
      res.status(503).json({ error: `Temporal cluster provisioning unavailable: ${err.message}` });
    }
  });

  // No standalone POST .../abort route: DELETE below already checks cluster.status ===
  // 'provisioning' and calls clusterService.abort() itself — a second route hitting the exact
  // same service method just meant two API paths (and two frontend buttons) for one operation.

  /**
   * Begins provisioning a cluster that was parked in 'awaiting-key' — the user has now installed
   * the public key we generated, so the private half we already hold will actually authenticate.
   *
   * Separate from POST /api/clusters because the key is useless until it is installed: starting
   * the workflow at creation time would spend all three of ProvisionClusterActivity's attempts on
   * "Permission denied (publickey)" before the user had a chance to paste anything.
   */
  app.post('/api/clusters/:id/start', async (req, res) => {
    try {
      const userId = (req as any).user.id;
      // Ownership-scoped: getById filters by owner, so another tenant's id is simply not found.
      const cluster = await clusterService.getById(req.params.id, userId);
      if (!cluster) return res.status(404).json({ error: 'Cluster not found' });
      if (cluster.status !== 'awaiting-key') {
        return res.status(409).json({ error: `Cluster "${cluster.name}" is ${cluster.status}, not awaiting a key.` });
      }
      if (!cluster.remoteHost || !cluster.remoteUsername || !cluster.remoteSshPrivateKeyEnc) {
        return res.status(400).json({ error: 'Cluster is missing its connection details.' });
      }

      const info = await temporalBridge.provision(cluster.name, 'remote', userId, {
        host: cluster.remoteHost,
        username: cluster.remoteUsername,
        privateKey: decryptValue(cluster.remoteSshPrivateKeyEnc, JWT_SECRET),
        ...(cluster.remoteSshPort !== undefined ? { port: cluster.remoteSshPort } : {}),
      });

      // provision() writes its own cluster row; drop the placeholder so the UI doesn't show two.
      const all = await db.getClusters();
      await db.saveClusterList(all.filter((c) => c.id !== cluster.id));

      res.status(202).json({ message: 'Provisioning started', id: info.resourceId, workflowId: info.id });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/clusters/:id', async (req, res) => {
    if (req.params.id === 'provisioning-lunorica') {
      return res.status(403).json({ error: 'The system management cluster cannot be destroyed' });
    }
    try {
      const cluster = await clusterService.getById(req.params.id, (req as any).user.id);
      if (!cluster) return res.status(404).json({ error: 'Cluster not found' });
      clusterProxyService.stopForCluster(req.params.id);
      if (cluster.status === 'provisioning') {
        await clusterService.abort(req.params.id, (req as any).user.id, io);
        return res.json({ success: true, message: 'Cluster provisioning aborted' });
      }
      const info = await temporalBridge.destroyCluster(req.params.id);
      res.status(202).json({
        message: 'Destroying cluster',
        clusterId: req.params.id,
        workflowId: info.id,
        state: 'running',
      });
    } catch (err: any) {
      // Fallback to clusterService.delete or abort
      try {
        await clusterService.abort(req.params.id, (req as any).user.id, io);
        res.json({ success: true, message: 'Cluster deleted' });
      } catch (fallbackErr: any) {
        res.status(503).json({ error: `Cluster destruction unavailable: ${err.message}` });
      }
    }
  });

  app.post('/api/clusters/discover', async (req, res) => {
    try {
      const discovered = await clusterService.discoverClusters((req as any).user.id);
      res.json({ clusters: discovered });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/clusters/:id/discover-deployments', async (req, res) => {
    try {
      const discovered = await appService.discoverDeployments(req.params.id, (req as any).user.id);
      res.json({ deployments: discovered });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/clusters/:id/all-pods', async (req, res) => res.json(await clusterService.listAllPods(req.params.id, (req as any).user.id)));
  app.get('/api/clusters/:id/helm-releases', async (req, res) => res.json(await clusterService.listReleases(req.params.id, (req as any).user.id)));
  app.get('/api/clusters/:id/gpu-status', async (req, res) => res.json(await clusterService.getGpuStatus(req.params.id, (req as any).user.id)));

  app.get('/api/clusters/:id/services', async (req, res) => {
    try {
      const cluster = await clusterService.getById(req.params.id, (req as any).user.id);
      if (!cluster) return res.status(404).json({ error: 'Cluster not found' });

      const releases = await clusterService.listReleases(req.params.id, (req as any).user.id);
      const pods = await clusterService.listAllPods(req.params.id, (req as any).user.id);

      // Grafana ships as a subchart *inside* the kube-prometheus-stack release (see
      // constructs/monitoring.ts: grafana.enabled=true), not its own separate Helm release —
      // matching only 'kube-prometheus-stack-grafana' here would never find a release and
      // always show "Not Installed" even when Grafana is actually running. Separate from
      // POD_NAME_PATTERNS below: this is only for the installed/status/chart/version fields,
      // not which pods list under each leaf — sharing one list for both would make Prometheus
      // and Grafana's leaves show each other's pods too. Confirmed live.
      const RELEASE_NAMES: Record<string, string[]> = {
        prometheus: ['kube-prometheus-stack', 'prometheus-server', 'prometheus'],
        grafana: ['kube-prometheus-stack', 'kube-prometheus-stack-grafana', 'grafana'],
        traefik: ['traefik'],
        gitea: ['gitea'],
        // Alertmanager ships as a subchart of kube-prometheus-stack too (same as Grafana above),
        // not its own release.
        alertmanager: ['kube-prometheus-stack'],
        // Loki and Promtail (constructs/logging.ts) are two separate Helm releases installed
        // together — matching either is enough for a simple installed/not-installed indicator on
        // one combined leaf (imperfect if exactly one of the two is down, acceptable for a
        // status leaf, not a health check).
        loki: ['loki', 'promtail'],
      };
      const POD_NAME_PATTERNS: Record<string, string[]> = {
        // Not 'alertmanager-kube-prometheus-stack' anymore — that now belongs solely to the
        // dedicated 'alertmanager' leaf below (same reasoning as Grafana already having its own
        // separate list: sharing pod patterns between two leaves makes them show each other's
        // pods too). Confirmed live.
        prometheus: ['kube-prometheus-stack-prometheus', 'kube-prometheus-stack-operator', 'kube-prometheus-stack-kube-state-metrics', 'kube-prometheus-stack-prometheus-node-exporter'],
        grafana: ['kube-prometheus-stack-grafana'],
        traefik: ['traefik'],
        gitea: ['gitea'],
        alertmanager: ['alertmanager-kube-prometheus-stack-alertmanager'],
        loki: ['loki', 'promtail'],
      };
      // Traefik deploys into its own 'traefik' namespace (constructs/ingress.ts), not
      // 'kube-system' — k3s's own bundled Traefik (which *would* live in kube-system) is
      // explicitly disabled at cluster-create time (scripts/cluster.sh: --disable=traefik),
      // so kube-system was never the right namespace for this platform's own Traefik release.
      // Confirmed live.
      const SERVICE_NAMESPACES: Record<string, string> = {
        prometheus: 'monitoring',
        grafana: 'monitoring',
        traefik: 'traefik',
        gitea: 'gitea',
        alertmanager: 'monitoring',
        loki: 'monitoring',
      };

      const services = Object.entries(RELEASE_NAMES).map(([serviceKey, chartNames]) => {
        const release = releases.find((r: any) => chartNames.includes(r.name));
        const namespace = SERVICE_NAMESPACES[serviceKey];
        const podPatterns = POD_NAME_PATTERNS[serviceKey] || [];
        const servicePods = Array.isArray(pods) ? pods.filter((p: any) =>
          p?.metadata?.namespace === namespace &&
          podPatterns.some(name => (p?.metadata?.name || '').includes(name))
        ) : [];

        return {
          name: serviceKey,
          installed: !!release,
          status: release?.status || 'not-installed',
          chart: release?.chart || null,
          appVersion: release?.app_version || null,
          namespace,
          pods: servicePods.map((p: any) => ({
            name: p?.metadata?.name || 'unknown',
            status: p?.status?.phase || 'Unknown',
            ip: p?.status?.podIP || null,
            ready: p?.status?.containerStatuses?.some((s: any) => s.ready) || false,
          })),
        };
      });

      res.json({ services });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /** ── DEPLOYMENTS ── */

  app.get('/api/deployments', async (req, res) => res.json(await appService.getAll((req as any).user.id, io)));

  app.post('/api/deployments', async (req, res) => {
    try {
      const user = (req as any).user;
      const targetCluster = await clusterService.getById(req.body.clusterId, user.id);
      if (!targetCluster) return res.status(404).json({ error: 'Cluster not found' });
      const info = await temporalBridge.deployApp(req.body, user?.id);
      res.status(202).json({
        message: 'Deployment started',
        deploymentName: req.body.name,
        id: info.resourceId,
        workflowId: info.id,
        state: 'running',
      });
    } catch (err: any) {
      res.status(503).json({ error: `Temporal app deploy unavailable: ${err.message}` });
    }
  });

  // No standalone POST .../abort route — same reasoning as clusters above: DELETE already
  // checks dep.status === 'deploying' and calls appService.abort() itself.

  app.delete('/api/deployments/:id', async (req, res) => {
    try {
      const dep = await appService.getById(req.params.id, (req as any).user.id);
      if (!dep) return res.status(404).json({ error: 'Deployment not found' });
      if (dep.status === 'deploying') {
        await appService.abort(req.params.id, (req as any).user.id, io);
        return res.json({ success: true, message: 'Deployment aborted' });
      }
      const info = await temporalBridge.destroyApp(req.params.id);
      res.status(202).json({
        message: 'Destroying app',
        deploymentId: req.params.id,
        workflowId: info.id,
        state: 'running',
      });
    } catch (err: any) {
      try {
        await appService.abort(req.params.id, (req as any).user.id, io);
        res.json({ success: true, message: 'Deployment deleted' });
      } catch (fallbackErr: any) {
        res.status(503).json({ error: `Deployment destruction unavailable: ${err.message}` });
      }
    }
  });

  app.get('/api/deployments/:id/helm', async (req, res) => res.json({ content: await appService.getHelmStatus(req.params.id, (req as any).user.id) }));
  app.get('/api/deployments/:id/diagnostics', async (req, res) => res.json({ content: await appService.getDiagnostics(req.params.id, (req as any).user.id) }));
  app.get('/api/deployments/:id/pods', async (req, res) => {
    try { res.json(await appService.listPods(req.params.id, (req as any).user.id)); } catch { res.status(500).json({ error: 'Failed to list pods' }); }
  });

  app.post('/api/deployments/:id/expose', async (req, res) => {
    try {
      const dep = await appService.getById(req.params.id, (req as any).user.id);
      if (!dep) return res.status(404).json({ error: 'Deployment not found' });
      // The whole exposure path is HTTP — Traefik by Host header, then an HTTPS localtunnel. For a
      // UDP game server it would build a working tunnel to nothing, so refuse rather than hand
      // back a URL that can never carry game traffic. The UI hides the control too; this is the
      // guard for a direct API call.
      if (NO_WEB_UI_APP_TYPES.has(dep.appType ?? '')) {
        return res.status(400).json({
          error: `"${dep.appType}" has no HTTP interface to expose — players connect directly to the cluster node on its game port.`,
        });
      }
      const mode = req.body?.mode === 'local' ? 'local' : 'public';
      const result = mode === 'local' ? await appExposureService.exposeLocal(req.params.id) : await appExposureService.exposePublic(req.params.id);
      res.json(result);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  app.post('/api/deployments/:id/unexpose', async (req, res) => {
    try {
      if (!(await appService.getById(req.params.id, (req as any).user.id))) return res.status(404).json({ error: 'Deployment not found' });
      const mode = req.body?.mode === 'local' ? 'local' : 'public';
      const result = mode === 'local' ? await appExposureService.unexposeLocal(req.params.id) : await appExposureService.unexposePublic(req.params.id);
      res.json(result);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  app.patch('/api/deployments/:id/exposure-path', async (req, res) => {
    try {
      if (!(await appService.getById(req.params.id, (req as any).user.id))) return res.status(404).json({ error: 'Deployment not found' });
      const { path } = req.body;
      res.json(await appExposureService.updateExposurePath(req.params.id, path));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /** ── PROJECTS (CI/CD: sibling repos hosted on the self-hosted Gitea) ── */

  /**
   * Projects were the one resource with no ownership model at all — every user saw every project,
   * and the socket rooms for their pipeline runs inherited that. Projects created from here on
   * carry an ownerId; projects that predate it have none and stay admin-only rather than staying
   * visible to everyone (this instance's only projects are the admin's own, so nothing is
   * stranded — on a shared instance that would deserve a migration instead).
   */
  const ownsProject = (project: any, user: any): boolean =>
    project?.ownerId ? project.ownerId === user.id : user.isAdmin === true;

  const getOwnedProject = async (id: string, user: any): Promise<any | undefined> => {
    const project = (await db.getProjects()).find((p: any) => p.id === id);
    return project && ownsProject(project, user) ? project : undefined;
  };

  app.get('/api/projects', async (req, res) => {
    const projects = await db.getProjects();
    res.json(projects.filter((p: any) => ownsProject(p, (req as any).user)));
  });

  app.get('/api/projects/:id/runs', async (req, res) => {
    if (!(await getOwnedProject(req.params.id, (req as any).user))) {
      return res.status(404).json({ error: 'Project not found' });
    }
    const runs = await db.getPipelineRuns();
    res.json(runs.filter((r: any) => r.projectId === req.params.id).sort((a: any, b: any) => b.startedAt.localeCompare(a.startedAt)));
  });

  app.post('/api/projects', async (req, res) => {
    try {
      const { name, giteaOwner, giteaRepo, createRepo, targetClusterId, targetNamespace, autoDeployOnBuild } = req.body;
      if (!name || !giteaRepo) return res.status(400).json({ error: 'name and giteaRepo are required' });

      // A NEW repository is created under the requesting user's own Gitea account, not the shared
      // admin one. That is what makes a sandbox push token safe to hand out: its reach is one
      // user's repositories rather than every tenant's. Registering an EXISTING repo still honours
      // an explicit owner, so the pipeline projects that predate per-user accounts keep working.
      let owner = giteaOwner || giteaService.adminUsername;

      if (createRepo) {
        const account = await projectRepoService.ensureAccountFor((req as any).user.id);
        owner = account.username;
        await giteaService.createRepoForUser(owner, giteaRepo, { description: `Provisioning project: ${name}` });
      } else {
        await giteaService.getRepo(owner, giteaRepo); // throws if it doesn't exist / isn't reachable
      }

      const id = uuidv4();
      const webhookSecret = crypto.randomBytes(32).toString('hex');

      // Gitea's webhook delivery needs a URL reachable from inside its pod, back out to this
      // backend process on the host — the node's own LAN IP (this platform's management
      // cluster is native k3s, sharing the host's network stack, not a nested Docker container
      // like AppExposureService's k3d-server-container case) is the one address guaranteed to
      // work in both directions on this platform's actual (Linux) deployment target.
      // A dual-stack node reports multiple InternalIP entries (IPv4 + IPv6) — jsonpath's
      // filter returns all of them space-joined, not just one. Confirmed live: this produced a
      // malformed multi-address URL Gitea rejected outright. The IPv4 address is always first.
      const nodeIpRaw = (await infraService.runKubectl(
        ['get', 'nodes', '-o', 'jsonpath={.items[0].status.addresses[?(@.type=="InternalIP")].address}'],
        '/tmp/kubeconfig-provisioning-lunorica',
      )).trim();
      const nodeIp = nodeIpRaw.split(/\s+/)[0];
      const backendPort = process.env.PORT || 3001;
      await giteaService.createWebhook(owner, giteaRepo, `http://${nodeIp}:${backendPort}/webhooks/gitea/${id}`, webhookSecret);

      const project = await db.saveProjectInfo({
        id,
        name,
        giteaOwner: owner,
        giteaRepo,
        ownerId: (req as any).user.id,
        appType: 'gitapp',
        ...(targetClusterId ? { targetClusterId } : {}),
        ...(targetNamespace ? { targetNamespace } : {}),
        autoDeployOnBuild: autoDeployOnBuild === true,
        webhookSecretEnc: encryptValue(webhookSecret, JWT_SECRET),
        createdAt: new Date().toISOString(),
      });
      res.status(201).json(project);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/projects/:id/runs/:runId/promote', async (req, res) => {
    try {
      const user = (req as any).user;
      const project = await getOwnedProject(req.params.id, user);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      const runs = await db.getPipelineRuns();
      const run = runs.find((r: any) => r.id === req.params.runId && r.projectId === project.id);
      if (!run) return res.status(404).json({ error: 'Run not found' });

      const info = await temporalBridge.promoteProjectBuild(project, run, user?.id);
      res.status(202).json({ message: 'Promoting build to deployment', workflowId: info.id, deploymentId: info.resourceId });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

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

  async function executeWebSearch(query: string): Promise<{ title: string; snippet: string; url: string }[]> {
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
      },
      call,
    );
  }

  /** ── HARNESS — what the agent is configured to do, and experiments against it ── */

  /**
   * Client task shapes → stored tasks.
   *
   * Ids are generated here rather than trusted. The client's copy only has to be unique within its
   * own form, while these become part of a Kubernetes namespace and are what results are attributed
   * by — so position decides identity, and editing a task in place keeps its results attached.
   */
  const normaliseTasks = (tasks: any[]): ExperimentTask[] =>
    tasks.slice(0, MAX_TASKS).map((t: any, i: number) => ({
      id: `t${i + 1}`,
      name: String(t?.name ?? '').trim().slice(0, 80) || `Task ${i + 1}`,
      prompt: String(t?.prompt ?? '').slice(0, MAX_TASK_CHARS),
      verifyCommand: String(t?.verifyCommand ?? '').trim().slice(0, 2000),
      // The world the agent wakes up in, and a reference answer used only by the gate. Both
      // optional; a task that starts from nothing carries neither.
      ...(Array.isArray(t?.seed) && t.seed.length ? { seed: taskFiles(t.seed) } : {}),
      ...(Array.isArray(t?.solution) && t.solution.length ? { solution: taskFiles(t.solution) } : {}),
      ...(isWorkspaceLanguage(t?.language) ? { language: t.language } : {}),
    }));

  /** File lists from a client, bounded and stripped of anything that could escape /work. */
  const taskFiles = (raw: any[]): { path: string; content: string }[] =>
    raw
      .slice(0, MAX_TASK_FILES)
      .map((f: any) => ({
        path: String(f?.path ?? '').trim(),
        content: String(f?.content ?? '').slice(0, MAX_TASK_FILE_CHARS),
      }))
      .filter((f) => f.path && !f.path.startsWith('/') && !f.path.includes('..'));

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

  app.post('/api/harness/workbench/open', async (req, res) => {
    try {
      const { language, seed } = req.body ?? {};
      res.json(await workbenchService.open((req as any).user.id, {
        ...(isWorkspaceLanguage(language) ? { language } : {}),
        ...(Array.isArray(seed) ? { seed: taskFiles(seed) } : {}),
      }));
    } catch (err: any) {
      res.status(503).json({ error: `Could not open a sandbox: ${String(err?.message ?? err).slice(0, 200)}` });
    }
  });

  app.post('/api/harness/workbench/exec', async (req, res) => {
    const { sessionId, command } = req.body ?? {};
    if (!String(command ?? '').trim()) return res.status(400).json({ error: 'No command.' });
    try {
      res.json(await workbenchService.exec((req as any).user.id, String(sessionId), String(command)));
    } catch (err: any) {
      // A dead session is the common case — the idle reaper took it — and is worth saying plainly
      // so the client can reopen rather than showing a failure that looks like the command's.
      res.status(409).json({ error: String(err?.message ?? err).slice(0, 200) });
    }
  });

  app.post('/api/harness/workbench/reset', async (req, res) => {
    const { sessionId, seed } = req.body ?? {};
    try {
      await workbenchService.reset(
        (req as any).user.id,
        String(sessionId),
        Array.isArray(seed) ? taskFiles(seed) : undefined,
      );
      res.json({ reset: true });
    } catch (err: any) {
      res.status(409).json({ error: String(err?.message ?? err).slice(0, 200) });
    }
  });

  app.delete('/api/harness/workbench/:sessionId', async (req, res) => {
    await workbenchService.close((req as any).user.id, req.params.sessionId).catch(() => undefined);
    res.json({ closed: true });
  });

  /** ── AUTHORING — Koala proposes the suite, the sandbox proves the verify commands ── */

  /**
   * Asks Koala for tasks. Proposals only — nothing is stored and nothing runs.
   *
   * Reasoning is OFF here, unlike the planning chat. Authoring is one-shot structured output, and
   * measured on this prompt with reasoning on the model produced 16,664 characters of deliberation,
   * hit the token ceiling and emitted no answer at all.
   */
  app.post('/api/harness/author/tasks', async (req, res) => {
    const { goal, existing, modelId } = req.body ?? {};
    if (!String(goal ?? '').trim()) return res.status(400).json({ error: 'Say what the suite should test.' });

    let provider, baseUrl, apiKey;
    try {
      ({ provider, baseUrl, apiKey } = await modelService.resolveBaseUrl((req as any).user.id, modelId));
    } catch (err: any) {
      return res.status(404).json({ error: err.message });
    }

    try {
      const upstream = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          ...(provider.model ? { model: provider.model } : {}),
          messages: [
            {
              role: 'system',
              content: buildTaskAuthorPrompt(
                Array.isArray(existing) ? { existing: existing.map((n: unknown) => String(n)) } : {},
              ),
            },
            { role: 'user', content: String(goal).slice(0, 2000) },
          ],
          stream: false,
          ...conversationSampling(provider.kind),
          ...AUTHORING_SAMPLING,
          max_tokens: AUTHORING_MAX_TOKENS,
        }),
      });

      if (!upstream.ok) {
        return res.status(502).json({ error: `Model call failed (${upstream.status})` });
      }
      const body: any = await upstream.json();
      const reply = body?.choices?.[0]?.message?.content ?? '';
      const { tasks, rejected } = extractTaskProposals(reply);

      // The prose without the payload — the tasks are rendered as cards, so leaving the JSON in
      // would show the same thing twice.
      res.json({ tasks, rejected, note: stripTaskBlock(reply) });
    } catch (err: any) {
      res.status(502).json({ error: String(err?.message ?? err).slice(0, 300) });
    }
  });

  /**
   * Runs each proposed verify command in an empty sandbox and requires it to FAIL.
   *
   * The gate that matters. A command that passes where no work has been done passes always, so a
   * suite built from such commands scores every variant a winner — the exact failure the Lab
   * exists to catch, produced automatically. One sandbox for the batch; see AuthoringService.
   */
  app.post('/api/harness/author/validate', async (req, res) => {
    const { tasks } = req.body ?? {};
    if (!Array.isArray(tasks) || !tasks.length) {
      return res.status(400).json({ error: 'Nothing to validate.' });
    }
    if (tasks.length > MAX_TASKS) {
      return res.status(400).json({ error: `At most ${MAX_TASKS} tasks in a suite.` });
    }

    try {
      const validated = await authoringService.validateOnEmptyWorkspace(
        (req as any).user.id,
        // Through `normaliseTasks` rather than a second hand-written mapping. The duplicate here
        // silently dropped seed and solution, so the gate validated a task with neither and
        // reported it fine — the exact class of silent drop the gate exists to catch.
        normaliseTasks(tasks),
      );
      res.json({ tasks: validated, accepted: acceptedTasks(validated) });
    } catch (err: any) {
      // A cluster problem is not a verdict on the commands — saying otherwise would reject good
      // tasks for a reason that has nothing to do with them.
      res.status(503).json({ error: `Could not reach a sandbox: ${String(err?.message ?? err).slice(0, 200)}` });
    }
  });

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

  /**
   * Refuses an arm pointing at a persona that is not yours or no longer exists.
   *
   * Checked at save rather than at run: an arm labelled "runs as Reviewer" that silently resolves
   * to nobody produces numbers filed under a configuration nothing used, which is the single
   * failure this whole surface is built to prevent.
   */
  const unknownPersona = async (userId: string, variants: unknown): Promise<string | undefined> => {
    if (!Array.isArray(variants)) return undefined;
    const wanted = variants
      .map((v) => (v && typeof v === 'object' ? (v as any).personaId : undefined))
      .filter((id): id is string => typeof id === 'string' && id !== '');
    if (!wanted.length) return undefined;
    const mine = new Set((await db.getPersonas()).filter((p) => p.ownerId === userId).map((p) => p.id));
    const missing = wanted.find((id) => !mine.has(id));
    return missing ? `No persona ${missing} — it may have been deleted.` : undefined;
  };

  /** ── PERSONAS — named configurations you pick, rather than the one everybody gets ── */

  app.get('/api/personas', async (req, res) => {
    res.json(await ownedPersonas((req as any).user.id));
  });

  app.post('/api/personas', async (req, res) => {
    const userId = (req as any).user.id;
    const { name, description, systemPrompt, overrides } = req.body ?? {};

    const existing = await ownedPersonas(userId);
    const refusal = validatePersona({ name: String(name ?? ''), systemPrompt }, existing);
    if (refusal) return res.status(400).json({ error: refusal });

    // The same registry check every other override bag gets. A persona is not a way around it.
    const invalid = validateOverrides(overrides ?? {});
    if (invalid) return res.status(400).json({ error: invalid });

    const now = new Date().toISOString();
    const persona: Persona = {
      id: uuidv4(),
      ownerId: userId,
      name: String(name).trim(),
      ...(description ? { description: String(description).slice(0, 200) } : {}),
      ...(systemPrompt ? { systemPrompt: String(systemPrompt) } : {}),
      overrides: overrides ?? {},
      createdAt: now,
      updatedAt: now,
    };
    await db.savePersona(persona);
    res.status(201).json(persona);
  });

  app.put('/api/personas/:id', async (req, res) => {
    const userId = (req as any).user.id;
    const existing = await ownedPersonas(userId);
    const persona = existing.find((p) => p.id === req.params.id);
    if (!persona) return res.status(404).json({ error: 'No such persona' });

    const { name, description, systemPrompt, overrides } = req.body ?? {};
    const nextName = name === undefined ? persona.name : String(name);
    const refusal = validatePersona({ name: nextName, systemPrompt }, existing, persona.id);
    if (refusal) return res.status(400).json({ error: refusal });
    if (overrides !== undefined) {
      const invalid = validateOverrides(overrides);
      if (invalid) return res.status(400).json({ error: invalid });
    }

    const updated: Persona = {
      ...persona,
      name: nextName.trim(),
      ...(description !== undefined ? { description: String(description).slice(0, 200) } : {}),
      ...(systemPrompt !== undefined ? { systemPrompt: String(systemPrompt) } : {}),
      ...(overrides !== undefined ? { overrides } : {}),
      updatedAt: new Date().toISOString(),
    };
    await db.savePersona(updated);
    res.json(updated);
  });

  app.delete('/api/personas/:id', async (req, res) => {
    const userId = (req as any).user.id;
    const persona = (await ownedPersonas(userId)).find((p) => p.id === req.params.id);
    if (!persona) return res.status(404).json({ error: 'No such persona' });

    /**
     * Leaves keep their `personaId` after the persona is gone.
     *
     * Clearing it would rewrite the record of what a completed leaf ran under, which is the one
     * thing history must never do — the same reason a superseded profile is filed rather than
     * overwritten. A dangling id resolves to nobody and the leaf simply runs with no persona.
     */
    await db.deletePersona(persona.id);
    res.json({ deleted: true });
  });

  app.get('/api/harness/profile', async (req, res) => {
    res.json(await db.getHarnessProfile((req as any).user.id));
  });

  /** Directly updates adopted profile overrides. */
  app.put('/api/harness/profile', async (req, res) => {
    const userId = (req as any).user.id;
    const { overrides } = req.body ?? {};
    if (typeof overrides !== 'object' || overrides === null) {
      return res.status(400).json({ error: 'overrides must be an object' });
    }
    const invalid = validateOverrides(overrides);
    if (invalid) return res.status(400).json({ error: invalid });

    const current = await db.getHarnessProfile(userId);
    const updatedProfile: HarnessProfile = {
      ownerId: userId,
      overrides,
      updatedAt: new Date().toISOString(),
      ...(current?.reason ? { reason: current.reason } : {}),
      ...(current?.promotedFrom ? { promotedFrom: current.promotedFrom } : {}),
    };
    await db.saveHarnessProfile(supersede(current, updatedProfile));
    res.json(updatedProfile);
  });

  /**
   * Adopts a variant's configuration as the default.
   *
   * Deliberately does NOT refuse a variant that lost. A variant that ties on verification while
   * costing half the tokens is worth adopting, and so is one that loses on a suite you have judged
   * unrepresentative — refusing would push the same decision into a hand-edited config where no
   * evidence is recorded at all. What it does instead is compute the standing server-side and
   * store it, so a default can always explain what it beat and by how much.
   */
  app.post('/api/harness/profile/promote', async (req, res) => {
    const userId = (req as any).user.id;
    const { experimentId, label } = req.body ?? {};

    const experiment = (await db.getExperiments())
      .find((e) => e.id === experimentId && e.ownerId === userId);
    if (!experiment) return res.status(404).json({ error: 'No such experiment' });

    const current = await db.getHarnessProfile(userId);
    const built = buildPromotion(experiment, String(label ?? ''), current, userId);
    if (!built) return res.status(400).json({ error: 'That variant has no results to promote.' });

    const invalid = validateOverrides(built.profile.overrides);
    if (invalid) return res.status(400).json({ error: invalid });

    // Filed rather than overwritten: adopting a default has to be undoable, and a diff needs
    // something to diff against.
    await db.saveHarnessProfile(supersede(current, built.profile));
    res.json(built);
  });

  /** Previews a promotion without applying it, so the diff can be shown before the button. */
  app.get('/api/harness/profile/preview', async (req, res) => {
    const userId = (req as any).user.id;
    const experiment = (await db.getExperiments())
      .find((e) => e.id === req.query.experimentId && e.ownerId === userId);
    if (!experiment) return res.status(404).json({ error: 'No such experiment' });

    const built = buildPromotion(
      experiment,
      String(req.query.label ?? ''),
      await db.getHarnessProfile(userId),
      userId,
    );
    if (!built) return res.status(400).json({ error: 'That variant has no results to promote.' });
    res.json({ standing: built.standing, changes: built.changes });
  });

  /** Back to the harness's built-in settings — but the configuration dropped is kept. */
  app.delete('/api/harness/profile', async (req, res) => {
    const userId = (req as any).user.id;
    const current = await db.getHarnessProfile(userId);
    if (!current) return res.json({ reset: true });

    // Not a delete. Resetting is a change like any other, and a reset you cannot undo is how an
    // afternoon of tuning disappears on one click.
    await db.saveHarnessProfile(supersede(current, { ownerId: userId, overrides: {}, updatedAt: '' }));
    res.json({ reset: true });
  });

  /** Restores a superseded configuration, filing the current one on the way. */
  app.post('/api/harness/profile/revert', async (req, res) => {
    const userId = (req as any).user.id;
    const current = await db.getHarnessProfile(userId);
    if (!current) return res.status(404).json({ error: 'Nothing has been adopted yet.' });

    const reverted = revertTo(current, String(req.body?.versionId ?? ''));
    if (!reverted) return res.status(404).json({ error: 'No such version.' });

    await db.saveHarnessProfile(reverted);
    res.json(reverted);
  });

  /**
   * The list: scores only.
   *
   * Full records carry a trace per run — up to 24 steps of several kilobytes each — plus every
   * task's prompt and every run's verify output. Returning those here meant the client re-fetched
   * the entire archive every five seconds, which was survivable only while probe experiments
   * deleted themselves. Once history persists it grows without bound, so evidence moved to the
   * detail route and this carries what the matrix renders.
   */
  app.get('/api/harness/experiments', async (req, res) => {
    const mine = (await db.getExperiments()).filter((e) => e.ownerId === (req as any).user.id);
    res.json(
      mine
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        // Recomputed rather than stored: a backend restart during a run leaves the record saying
        // "running" forever, and the service is the only thing that knows the truth.
        .map((e) => ({ ...summariseExperiment(e), running: experimentService.isRunning(e.id) })),
    );
  });

  /** One experiment in full — prompts, traces, requests. Fetched when something is expanded. */
  app.get('/api/harness/experiments/:id', async (req, res) => {
    const experiment = (await db.getExperiments())
      .find((e) => e.id === req.params.id && e.ownerId === (req as any).user.id);
    if (!experiment) return res.status(404).json({ error: 'No such experiment' });
    // Normalised like the list is, so the client never branches on a record's age.
    res.json({ ...normaliseExperiment(experiment), running: experimentService.isRunning(experiment.id) });
  });

  app.post('/api/harness/experiments', async (req, res) => {
    const { name, tasks, task, verifyCommand, language, variants, axes, repeats } = req.body ?? {};
    // Axes are the friendlier form — one question at a time — and expand to explicit variants so a
    // stored experiment always says exactly what it ran.
    const resolved = Array.isArray(variants) && variants.length
      ? variants
      : expandAxes(axes && typeof axes === 'object' ? axes : {});

    // A suite, or the single task the older client sends — both normalise to the same stored
    // shape, so nothing downstream has to ask which one arrived.
    const suite: ExperimentTask[] = Array.isArray(tasks) && tasks.length
      ? normaliseTasks(tasks)
      : [{
          id: 't1',
          name: 'Task',
          prompt: String(task ?? '').slice(0, MAX_TASK_CHARS),
          verifyCommand: String(verifyCommand ?? '').trim().slice(0, 2000),
        }];

    const draft: Experiment = {
      id: uuidv4(),
      ownerId: (req as any).user.id,
      name: String(name ?? '').trim().slice(0, 120),
      tasks: suite,
      language: isWorkspaceLanguage(language) ? language : 'node',
      variants: resolved,
      repeats: Math.max(1, Math.min(MAX_REPEATS, Number(repeats) || 1)),
      status: 'draft',
      results: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const invalid = validateExperiment(draft);
    if (invalid) return res.status(400).json({ error: invalid });

    await db.saveExperiment(draft);
    res.status(201).json(draft);
  });

  /**
   * Edits an experiment in place.
   *
   * ── WHY EDITING A PROMPT DISCARDS THAT TASK'S RESULTS ──
   * A result is a measurement OF a prompt. Change the prompt and keep the number and the record
   * quietly asserts something that was never run — the worst kind of wrong, because it looks like
   * evidence. So results are dropped for exactly the tasks whose prompt or verify command moved,
   * and kept for the ones that did not. `duplicate` is the non-destructive path when the old
   * numbers are worth keeping alongside the new ones.
   */
  app.put('/api/harness/experiments/:id', async (req, res) => {
    const existing = (await db.getExperiments())
      .find((e) => e.id === req.params.id && e.ownerId === (req as any).user.id);
    if (!existing) return res.status(404).json({ error: 'No such experiment' });
    if (experimentService.isRunning(existing.id)) {
      return res.status(409).json({ error: 'Still running — wait for it to finish before editing.' });
    }

    const { name, tasks, variants, axes, repeats } = req.body ?? {};
    const before = experimentTasks(existing);
    const suite = Array.isArray(tasks) && tasks.length ? normaliseTasks(tasks) : before;
    const badPersona = await unknownPersona((req as any).user.id, variants);
    if (badPersona) return res.status(400).json({ error: badPersona });

    const resolvedVariants = Array.isArray(variants) && variants.length
      ? variants
      : axes && typeof axes === 'object'
        ? expandAxes(axes)
        : existing.variants;

    // Spread the existing record: saveExperiment replaces the whole document, so anything not
    // carried forward here would be silently deleted.
    const next: Experiment = {
      ...existing,
      name: name === undefined ? existing.name : String(name).trim().slice(0, 120),
      tasks: suite,
      variants: resolvedVariants,
      repeats: repeats === undefined
        ? existing.repeats
        : Math.max(1, Math.min(MAX_REPEATS, Number(repeats) || 1)),
      updatedAt: new Date().toISOString(),
    };

    const invalid = validateExperiment(next);
    if (invalid) return res.status(400).json({ error: invalid });

    /**
     * Editing keeps every past execution.
     *
     * This used to delete results whose prompt had changed, on the reasoning that a number
     * attached to wording it never measured is a lie. That was right when a record held ONE set of
     * results and nothing about the conditions. It stopped being right when runs became history:
     * every execution now stores the prompt it was actually sent, the parameters as they went out,
     * and which keys came from the profile — so an old run is a self-describing record of what was
     * asked then, not a claim about what is asked now.
     *
     * Deleting it would throw away the very evidence that makes "re-run it after the change"
     * answerable, which is the entire reason the suite is written down.
     */
    const changedTasks = suite
      .filter((t) => {
        const was = before.find((b) => b.id === t.id);
        return !was || was.prompt !== t.prompt || was.verifyCommand !== t.verifyCommand;
      })
      .map((t) => t.name);
    const variantsChanged = JSON.stringify(resolvedVariants) !== JSON.stringify(existing.variants);

    await db.saveExperiment(next);
    // Reported rather than acted on: the next run answers the new question, and the history says
    // what the old one answered.
    res.json({
      ...next,
      changedTasks,
      variantsChanged,
      priorRuns: (existing.runs?.length ?? 0) || (latestResults(existing).length ? 1 : 0),
    });
  });

  /** Copies an experiment without its results — the non-destructive way to try a reworded prompt. */
  app.post('/api/harness/experiments/:id/duplicate', async (req, res) => {
    const existing = (await db.getExperiments())
      .find((e) => e.id === req.params.id && e.ownerId === (req as any).user.id);
    if (!existing) return res.status(404).json({ error: 'No such experiment' });

    const now = new Date().toISOString();
    const copy: Experiment = {
      ...existing,
      id: uuidv4(),
      name: `${existing.name} (copy)`.slice(0, 120),
      tasks: experimentTasks(existing),
      status: 'draft',
      results: [],
      progress: undefined,
      error: undefined,
      createdAt: now,
      updatedAt: now,
    };
    await db.saveExperiment(copy);
    res.status(201).json(copy);
  });

  app.post('/api/harness/experiments/:id/run', async (req, res) => {
    const experiment = (await db.getExperiments())
      .find((e) => e.id === req.params.id && e.ownerId === (req as any).user.id);
    if (!experiment) return res.status(404).json({ error: 'No such experiment' });
    if (experimentService.isRunning(experiment.id)) {
      return res.status(409).json({ error: 'Already running' });
    }

    // Returns immediately: an experiment is minutes of real sandboxes and inference, and the UI
    // polls for results as each variant lands.
    experimentService.start(experiment);
    res.status(202).json({ started: true, runs: plannedRuns(experiment) });
  });

  app.post('/api/harness/experiments/:id/stop', async (req, res) => {
    const experiment = (await db.getExperiments())
      .find((e) => e.id === req.params.id && e.ownerId === (req as any).user.id);
    if (!experiment) return res.status(404).json({ error: 'No such experiment' });
    if (experimentService.isRunning(experiment.id)) {
      experimentService.stop(experiment.id);
    }
    const runs = (experiment as any).runs ?? [];
    const updatedRuns = runs.map((r: any) => ({
      ...r,
      status: r.status === 'running' ? 'complete' : r.status,
      finishedAt: r.finishedAt || new Date().toISOString(),
    }));
    await db.saveExperiment({
      ...experiment,
      status: experiment.results?.length || updatedRuns.some((r: any) => r.results?.length) ? 'complete' : 'draft',
      runs: updatedRuns,
      progress: undefined,
      updatedAt: new Date().toISOString(),
    });
    res.json({ stopped: true });
  });

  app.delete('/api/harness/experiments/:id', async (req, res) => {
    const experiment = (await db.getExperiments())
      .find((e) => e.id === req.params.id && e.ownerId === (req as any).user.id);
    if (!experiment) return res.status(404).json({ error: 'No such experiment' });
    if (experimentService.isRunning(experiment.id)) {
      experimentService.stop(experiment.id);
    }
    await db.deleteExperiment(experiment.id);
    res.json({ deleted: true });
  });

  // ── TOOL REPOSITORY ──
  app.get('/api/harness/tools', async (req, res) => {
    const category = typeof req.query.category === 'string' ? req.query.category : undefined;
    const all = await db.getTools();
    if (category && category !== 'all') {
      return res.json(all.filter((t) => t.category === category));
    }
    res.json(all);
  });

  app.post('/api/harness/tools', async (req, res) => {
    const { name, category, description, requiresBinaries, parameters, scriptCommand } = req.body;
    if (!name || !description) {
      return res.status(400).json({ error: 'name and description are required' });
    }
    const item = {
      id: uuidv4(),
      name: String(name).trim(),
      category: category || 'custom',
      description: String(description).trim(),
      requiresBinaries: Array.isArray(requiresBinaries) ? requiresBinaries : [],
      parameters: parameters || { type: 'object', properties: {} },
      scriptCommand: scriptCommand ? String(scriptCommand) : undefined,
      isBuiltIn: false,
    };
    await db.saveTool(item as any);
    res.status(201).json(item);
  });

  app.put('/api/harness/tools/:id', async (req, res) => {
    const existing = (await db.getTools()).find((t) => t.id === req.params.id);
    if (!existing) return res.status(404).json({ error: 'No such tool' });
    const { name, category, description, requiresBinaries, parameters, scriptCommand } = req.body;
    const updated = {
      ...existing,
      ...(name ? { name: String(name).trim() } : {}),
      ...(category ? { category } : {}),
      ...(description ? { description: String(description).trim() } : {}),
      ...(requiresBinaries ? { requiresBinaries: Array.isArray(requiresBinaries) ? requiresBinaries : [] } : {}),
      ...(parameters ? { parameters } : {}),
      ...(scriptCommand !== undefined ? { scriptCommand: String(scriptCommand) } : {}),
    };
    await db.saveTool(updated as any);
    res.json(updated);
  });

  app.delete('/api/harness/tools/:id', async (req, res) => {
    const existing = (await db.getTools()).find((t) => t.id === req.params.id);
    if (!existing) return res.status(404).json({ error: 'No such tool' });
    await db.deleteTool(req.params.id);
    res.json({ deleted: true });
  });

  // ── MEMORY BANK ──
  app.get('/api/harness/memories', async (req, res) => {
    const ownerId = (req as any).user.id;
    const memories = await db.getMemories(ownerId);
    res.json(memories);
  });

  app.post('/api/harness/memories', async (req, res) => {
    const ownerId = (req as any).user.id;
    const { category, title, text, projectId, scope, recommendedScope, status } = req.body;
    if (!category || !title || !text) {
      return res.status(400).json({ error: 'category, title, and text are required' });
    }
    const item: MemoryItem = {
      id: uuidv4(),
      ownerId,
      projectId: projectId ? String(projectId) : undefined,
      category,
      scope: scope === 'global' ? 'global' : 'project',
      recommendedScope: recommendedScope === 'global' ? 'global' : 'project',
      status: status === 'pending_review' ? 'pending_review' : 'active',
      source: 'manual',
      title: String(title).trim(),
      text: String(text).trim(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await db.saveMemory(item);
    res.status(201).json(item);
  });

  app.put('/api/harness/memories/:id/approve', async (req, res) => {
    const ownerId = (req as any).user.id;
    const existing = (await db.getMemories(ownerId)).find((m) => m.id === req.params.id);
    if (!existing) return res.status(404).json({ error: 'No such memory item' });
    const updated: MemoryItem = {
      ...existing,
      status: 'active',
      updatedAt: new Date().toISOString(),
    };
    await db.saveMemory(updated);
    res.json(updated);
  });

  app.put('/api/harness/memories/:id/promote', async (req, res) => {
    const ownerId = (req as any).user.id;
    const existing = (await db.getMemories(ownerId)).find((m) => m.id === req.params.id);
    if (!existing) return res.status(404).json({ error: 'No such memory item' });
    const updated: MemoryItem = {
      ...existing,
      scope: 'global',
      updatedAt: new Date().toISOString(),
    };
    await db.saveMemory(updated);
    res.json(updated);
  });

  app.put('/api/harness/memories/:id', async (req, res) => {
    const ownerId = (req as any).user.id;
    const existing = (await db.getMemories(ownerId)).find((m) => m.id === req.params.id);
    if (!existing) return res.status(404).json({ error: 'No such memory item' });
    const { category, title, text, scope, status, projectId } = req.body;
    const updated: MemoryItem = {
      ...existing,
      ...(category ? { category } : {}),
      ...(title ? { title: String(title).trim() } : {}),
      ...(text ? { text: String(text).trim() } : {}),
      ...(scope ? { scope } : {}),
      ...(status ? { status } : {}),
      ...(projectId !== undefined ? { projectId } : {}),
      updatedAt: new Date().toISOString(),
    };
    await db.saveMemory(updated);
    res.json(updated);
  });

  app.delete('/api/harness/memories/:id', async (req, res) => {
    const ownerId = (req as any).user.id;
    const existing = (await db.getMemories(ownerId)).find((m) => m.id === req.params.id);
    if (!existing) return res.status(404).json({ error: 'No such memory item' });
    await db.deleteMemory(req.params.id);
    res.json({ deleted: true });
  });

  /** ── BRANCHES — one planning conversation each ── */

  const ownedBranches = async (userId: string): Promise<Branch[]> =>
    (await db.getBranches()).filter((b) => b.ownerId === userId);

  app.get('/api/branches', async (req, res) => {
    const branches = await ownedBranches((req as any).user.id);
    // Newest first: a conversation you just had is the one you want.
    res.json([...branches].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  });

  app.post('/api/branches', async (req, res) => {
    const user = (req as any).user;
    const now = new Date().toISOString();
    const branch: Branch = {
      id: uuidv4(),
      ownerId: user.id,
      title: typeof req.body?.title === 'string' && req.body.title.trim() ? req.body.title.trim() : 'New branch',
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    await db.saveBranch(branch);
    res.status(201).json(branch);
  });

  app.patch('/api/branches/:id', async (req, res) => {
    const user = (req as any).user;
    const branch = (await ownedBranches(user.id)).find((b) => b.id === req.params.id);
    if (!branch) return res.status(404).json({ error: 'Branch not found' });
    const { title } = req.body ?? {};
    if (typeof title !== 'string' || !title.trim()) return res.status(400).json({ error: 'title is required' });
    const updated = { ...branch, title: title.trim().slice(0, 200), updatedAt: new Date().toISOString() };
    await db.saveBranch(updated);
    res.json(updated);
  });

  app.delete('/api/branches/:id', async (req, res) => {
    const user = (req as any).user;
    const branch = (await ownedBranches(user.id)).find((b) => b.id === req.params.id);
    if (!branch) return res.status(404).json({ error: 'Branch not found' });
    // Its leaves go too. A leaf without its branch is unreachable in the tree and would still
    // count against nothing — an orphan nobody can see or delete.
    for (const leaf of (await ownedLeaves(user.id)).filter((l) => l.branchId === branch.id)) {
      await temporalBridge?.signalLeaf(leaf.id, 'cancelLeaf');
      await db.deleteLeaf(leaf.id);
    }
    await db.deleteBranch(branch.id);
    res.json({ success: true });
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

  app.get('/api/models', async (req, res) => {
    try {
      res.json(await modelService.list((req as any).user.id));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * Chooses which model does structured extraction.
   *
   * Deliberately explicit rather than auto-picking the smallest available: the right extractor is a
   * NON-REASONING model, and nothing in the registry records that. Guessing would silently
   * reproduce the failure this exists to fix.
   */
  app.put('/api/models/extractor', async (req, res) => {
    try {
      const user = (req as any).user;
      const { modelId } = req.body ?? {};
      if (modelId !== null && typeof modelId !== 'string') {
        return res.status(400).json({ error: 'modelId must be a string, or null to clear' });
      }
      if (modelId) {
        const owned = (await modelService.list(user.id)).some((m) => m.id === modelId);
        if (!owned) return res.status(404).json({ error: 'Model not found' });
      }
      const record = await db.getUserById(user.id);
      if (!record) return res.status(404).json({ error: 'User not found' });
      await db.saveUser({ ...record, ...(modelId ? { extractionModelId: modelId } : { extractionModelId: undefined }) });
      res.json({ success: true, extractionModelId: modelId || null });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/models/extractor', async (req, res) => {
    const record = await db.getUserById((req as any).user.id);
    res.json({ extractionModelId: record?.extractionModelId ?? null });
  });

  /**
   * Register any OpenAI-compatible API — Ollama on a laptop, llama.cpp, LM Studio, a hosted
   * provider. The URL is checked against endpoint-url-safety.ts BEFORE it is stored, because this
   * backend will later fetch it: without that, a registered endpoint is a server-side request
   * forgery primitive aimed at the root node, which runs Headscale, Mongo and Temporal on
   * loopback. Mesh addresses additionally have to be proven to belong to the caller's own machines.
   */
  app.post('/api/model-endpoints', async (req, res) => {
    try {
      const user = (req as any).user;
      const { name, baseUrl, model, apiKey } = req.body ?? {};
      if (!name || !baseUrl) return res.status(400).json({ error: 'name and baseUrl are required' });

      const check = checkEndpointUrl(String(baseUrl));
      if (!check.ok) return res.status(400).json({ error: check.reason });

      const isMesh = !!(check.literalIp && isMeshAddress(check.literalIp));
      if (isMesh) {
        // Fails closed — assertOwnsMeshAddress throws if Headscale is unreachable.
        const devices = await headscaleService.listUserDevices(user.id).catch((e: any) => {
          throw new Error(`Cannot verify ownership of ${check.literalIp} — the mesh is unreachable (${e.message})`);
        });
        if (!devices.some((d) => d.ipAddresses.includes(check.literalIp!))) {
          return res.status(403).json({ error: `${check.literalIp} is not one of your machines. Join it under My Machines first.` });
        }
      }

      const endpoint = {
        id: uuidv4(),
        ownerId: user.id,
        name: String(name),
        baseUrl: String(baseUrl).replace(/\/$/, ''),
        ...(model ? { model: String(model) } : {}),
        ...(apiKey ? { apiKeyEnc: encryptValue(String(apiKey), JWT_SECRET) } : {}),
        ...(isMesh ? { isMesh: true } : {}),
        createdAt: new Date().toISOString(),
      };
      await db.saveModelEndpoint(endpoint);
      // apiKeyEnc deliberately not echoed back.
      const { apiKeyEnc: _omit, ...safe } = endpoint as any;
      res.status(201).json({ ...safe, hasApiKey: !!apiKey });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.delete('/api/model-endpoints/:id', async (req, res) => {
    const user = (req as any).user;
    const endpoints = await db.getModelEndpoints();
    const owned = endpoints.find((e) => e.id === req.params.id && e.ownerId === user.id);
    // 404 for both "no such id" and "not yours", so this can't enumerate other tenants' endpoints.
    if (!owned) return res.status(404).json({ error: 'Endpoint not found' });
    await db.deleteModelEndpoint(req.params.id);
    res.json({ success: true });
  });

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
    const branchLeaves = branchId
      ? (await ownedLeaves((req as any).user.id)).filter((l) => l.branchId === branchId)
      : [];

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
    const outboundMessages = buildOutboundMessages({
      messages,
      lastIndex,
      prompt: explicitPlan ? PLAN_SYSTEM_PROMPT : extracting ? AMBIENT_PROPOSAL_PROMPT : undefined,
      leaves: branchLeaves,
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
          ...(offerTools ? { tools: LEAF_TOOLS } : {}),
          stream,
          maxTokens: rest.max_tokens ?? strategy.maxTokens,
          reasoningEffort: rest.reasoning_effort ?? strategy.reasoningEffort,
          extra: {
            max_completion_tokens: rest.max_tokens ?? strategy.maxTokens,
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
            res.write(`data: ${JSON.stringify({ interruptedReason: reasonMsg })}\n\n`);
            upstreamAbort.abort();
            break;
          }

          res.write(Buffer.from(value));
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
            tools: LEAF_TOOLS,
            stream: true,
            maxTokens: rest.max_tokens ?? strategy.maxTokens,
            reasoningEffort: rest.reasoning_effort ?? strategy.reasoningEffort,
            extra: {
              max_completion_tokens: rest.max_tokens ?? strategy.maxTokens,
              stream_options: { include_usage: true },
            },
          })),
          signal: upstreamAbort.signal,
        });
        if (!followUp.ok || !followUp.body) break;
        calls = await pump(followUp.body);
      }

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
        res.write(`data: ${JSON.stringify({ interruptedReason: `Used all ${MAX_TOOL_ROUNDS} research steps — answering with what was found.` })}\n\n`);
        conversation.push({
          role: 'user',
          content:
            'You have used all available research steps. Answer now with what you found. State '
            + 'plainly what you could not confirm rather than guessing at it.',
        });
        const finalPass = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
          body: JSON.stringify(turnRequest(conversation, {
            stream: true,
            maxTokens: rest.max_tokens ?? strategy.maxTokens,
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
        res.write(`data: ${JSON.stringify({ interruptedReason: 'Completion token cap reached (finish_reason: length) — auto-continuing...' })}\n\n`);
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
            await db.saveBranch({
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
          const proposals = proposedViaTools ? [] : (extracted?.length ? extracted : extractProposals(reply));
          const now = new Date().toISOString();
          for (const proposal of proposals) {
            await db.saveLeaf({
              id: uuidv4(),
              ownerId: (req as any).user.id,
              branchId: String(branchId),
              title: proposal.title,
              ...(proposal.body ? { body: proposal.body } : {}),
              column: 'todo',
              // Proposed, always: the model suggests, a human accepts. Nothing runs or spends here.
              status: 'proposed',
              depth: 0,
              blocking: true,
              createdAt: now,
              updatedAt: now,
            });
          }
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

  /** ── BOARD — agent harness Phase B (~/.claude/plans/agent-harness.md) ── */

  /**
   * Leaves are the durable unit of work, not a view over one: each leaf in an active column will map
   * to a Temporal workflow. Phase B is humans moving leaves; the workflow binding arrives with the
   * personas that act on them.
   */
  const ownedLeaves = async (userId: string): Promise<Leaf[]> =>
    (await db.getLeaves()).filter((c) => c.ownerId === userId);

  app.get('/api/leaves', async (req, res) => {
    const leaves = await ownedLeaves((req as any).user.id);
    // Scoped to a request: a leaf belongs to the ask that produced it, not to a long-lived board.
    const branchId = req.query.branchId;
    const scoped = typeof branchId === 'string' ? leaves.filter((c) => c.branchId === branchId) : leaves;
    // Effective status is DERIVED for a leaf with children — a parent dragged around while its
    // children are mid-flight would otherwise report something the workflow does not agree with.
    res.json(scoped.map((c) => {
      const kids = childrenOf(leaves, c.id);
      return {
        ...c,
        status: deriveLeafStatus(c.status, kids),
        childCount: kids.length,
        // Root leaves report their subtree's spend, so the board can show a budget being consumed
        // rather than only refusing once it is gone.
        ...(c.budget ? { usageTotal: aggregateUsage(leaves, c, Date.now()) } : {}),
      };
    }));
  });

  app.post('/api/leaves', async (req, res) => {
    try {
      const user = (req as any).user;
      const { title, body, branchId, column = 'todo', parentLeafId, blocking = true, personaId, projectId, budget, proposed = false } = req.body ?? {};
      if (!title || typeof title !== 'string') return res.status(400).json({ error: 'title is required' });
      // `column` is untrusted JSON; the union type validates nothing here.
      if (!isLeafColumn(column)) {
        return res.status(400).json({ error: `column must be one of: ${LEAF_COLUMNS.join(', ')}` });
      }

      const leaves = await ownedLeaves(user.id);
      let depth = 0;
      // A child ALWAYS belongs to its parent's request — the whole tree lives and dies together,
      // so letting a caller supply a different one would split a decomposition across requests.
      let resolvedBranchId = typeof branchId === 'string' && branchId ? branchId : uuidv4();
      if (parentLeafId) {
        const parent = leaves.find((c) => c.id === parentLeafId);
        // 404 for both "no such leaf" and "not yours", so this cannot enumerate other tenants.
        if (!parent) return res.status(404).json({ error: 'Parent leaf not found' });
        // Budget is NOT checked for a proposal. A proposal costs nothing — it starts no workflow
        // and spends no tokens — and refusing to even suggest work because the budget is gone
        // hides the very information a human needs to decide whether to raise it. The check moves
        // to the accept route, which is where spend is actually committed.
        if (proposed !== true) {
          const root = rootLeaf(leaves, parent);
          if (root?.budget) {
            const spent = budgetExceeded(root.budget, aggregateUsage(leaves, root, Date.now()));
            if (spent) return res.status(409).json({ error: `${spent} — this leaf's budget covers all of its sub-items` });
          }
        }

        const refusal = canAddChild(parent, childrenOf(leaves, parent.id).length);
        // Returned as a reason rather than a silent no-op: the caller (eventually a planner
        // persona) needs to know it was refused and why, or it will simply ask again.
        if (refusal) return res.status(409).json({ error: refusal });
        depth = parent.depth + 1;
        resolvedBranchId = parent.branchId;
      }

      const now = new Date().toISOString();
      const leaf: Leaf = {
        id: uuidv4(),
        ownerId: user.id,
        branchId: resolvedBranchId,
        title: title.trim(),
        column,
        // A proposal is a suggestion until someone accepts it: no workflow, no budget spent.
        status: proposed === true ? 'proposed' : 'pending',
        depth,
        blocking: blocking !== false,
        createdAt: now,
        updatedAt: now,
        ...(body ? { body: String(body) } : {}),
        ...(parentLeafId ? { parentLeafId: String(parentLeafId) } : {}),
        ...(personaId ? { personaId: String(personaId) } : {}),
        ...(projectId ? { projectId: String(projectId) } : {}),
        // Budgets live on the ROOT only: depth and fan-out caps alone still permit hundreds of
        // workspaces, so the ceiling has to cover the whole subtree.
        ...(!parentLeafId && budget ? { budget } : {}),
      };
      await db.saveLeaf(leaf);

      // A proposal gets no workflow at all — that is the entire point of the status. Nothing runs
      // and nothing is spent until someone accepts it, which the accept route handles.
      if (leaf.status === 'proposed') return res.status(201).json(leaf);

      // Start the workflow that backs this leaf, and tell the parent's workflow about it so the
      // child is a real Temporal child rather than just a row pointing at one. Both are
      // best-effort: Temporal being down must not stop someone writing on the board, the same way
      // cluster listing falls back to plain DB polling.
      const workflowId = await temporalBridge?.startLeaf(leaf);
      if (workflowId) {
        leaf.workflowId = workflowId;
        await db.saveLeaf(leaf);
      }
      if (parentLeafId) {
        await temporalBridge?.signalLeaf(String(parentLeafId), 'addChild', {
          leafId: leaf.id,
          title: leaf.title,
          blocking: leaf.blocking,
          // Position among siblings — what makes the child's workflow id deterministic, so a
          // retried signal addresses the same child instead of spawning a second.
          // Proposals are excluded so the index matches what the parent workflow has actually
          // been told about — counting them would skip an index and break the deterministic id.
          index: childrenOf(leaves, String(parentLeafId)).filter((c) => c.status !== 'proposed').length,
        });
      }
      res.status(201).json(leaf);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * Accepts a proposed leaf, turning a suggestion into work.
   *
   * Separate from PATCH because this is the moment spend is committed: the budget is re-checked
   * here rather than at proposal time, since a proposal costs nothing and a branch's budget may
   * well have been consumed between the suggestion and the decision.
   */
  app.post('/api/leaves/:id/accept', async (req, res) => {
    const user = (req as any).user;
    const leaves = await ownedLeaves(user.id);
    const leaf = leaves.find((c) => c.id === req.params.id);
    if (!leaf) return res.status(404).json({ error: 'Leaf not found' });
    if (leaf.status !== 'proposed') return res.status(409).json({ error: 'This leaf has already been accepted' });

    const root = rootLeaf(leaves, leaf);
    if (root?.budget) {
      const spent = budgetExceeded(root.budget, aggregateUsage(leaves, root, Date.now()));
      if (spent) return res.status(409).json({ error: `${spent} — accepting more work would exceed this branch's budget` });
    }

    const accepted = { ...leaf, status: 'pending' as const, updatedAt: new Date().toISOString() };
    await db.saveLeaf(accepted);

    /**
     * Started only when its turn has come.
     *
     * A leaf waiting on another stays `pending` with no workflow — which is what `pending` already
     * means. The reconcile loop starts it when the last thing it waits on succeeds. Accepting five
     * leaves at once used to start five workflows at once, so a plan whose steps built on each
     * other ran every step against an empty sandbox.
     */
    const waiting = blockedBy(accepted, leaves);
    const workflowId = waiting.length === 0 ? await temporalBridge?.startLeaf(accepted) : undefined;
    if (workflowId) {
      accepted.workflowId = workflowId;
      await db.saveLeaf(accepted);
    }
    if (waiting.length > 0) {
      // Said back, because a leaf that is accepted and not running otherwise looks broken.
      return res.json({ ...accepted, waitingFor: waiting.map((w) => ({ id: w.id, title: w.title })) });
    }
    if (accepted.parentLeafId) {
      await temporalBridge?.signalLeaf(accepted.parentLeafId, 'addChild', {
        leafId: accepted.id,
        title: accepted.title,
        blocking: accepted.blocking,
        index: childrenOf(leaves, accepted.parentLeafId).filter((c) => c.status !== 'proposed').length,
      });
    }
    res.json(accepted);
  });

  app.patch('/api/leaves/:id', async (req, res) => {
    const user = (req as any).user;
    const leaves = await ownedLeaves(user.id);
    const leaf = leaves.find((c) => c.id === req.params.id);
    if (!leaf) return res.status(404).json({ error: 'Leaf not found' });

    const { column, title, body, personaId } = req.body ?? {};
    if (column !== undefined && !isLeafColumn(column)) {
      return res.status(400).json({ error: `column must be one of: ${LEAF_COLUMNS.join(', ')}` });
    }
    // A leaf with children has a DERIVED status, so moving it by hand is refused rather than
    // silently ignored — dragging a parent while its children run is genuinely ambiguous.
    if (column && childrenOf(leaves, leaf.id).length > 0) {
      return res.status(409).json({ error: 'This leaf\'s state follows its sub-items — move those instead' });
    }
    const updated: Leaf = {
      ...leaf,
      ...(column ? { column } : {}),
      ...(title ? { title: String(title).trim() } : {}),
      ...(body !== undefined ? { body: String(body) } : {}),
      ...(personaId !== undefined ? { personaId: String(personaId) } : {}),
      updatedAt: new Date().toISOString(),
    };
    await db.saveLeaf(updated);
    // Moving a leaf IS a signal — that is the whole claim of the board being the state store
    // rather than a view over one. The row is written first so the board stays correct even when
    // Temporal is unreachable.
    if (column) await temporalBridge?.signalLeaf(leaf.id, 'moveLeaf', column);
    res.json(updated);
  });

  app.post('/api/leaves/:id/cancel', async (req, res) => {
    const user = (req as any).user;
    const leaf = (await ownedLeaves(user.id)).find((c) => c.id === req.params.id);
    if (!leaf) return res.status(404).json({ error: 'Leaf not found' });
    const signalled = await temporalBridge?.signalLeaf(leaf.id, 'cancelLeaf');
    await db.saveLeaf({ ...leaf, status: 'cancelled', updatedAt: new Date().toISOString() });
    // Reported honestly: with Temporal down the row says cancelled but nothing was actually
    // stopped, and pretending otherwise is how a "cancelled" job keeps burning budget.
    res.json({ success: true, workflowSignalled: signalled === true });
  });

  app.delete('/api/leaves/:id', async (req, res) => {
    const user = (req as any).user;
    const leaves = await ownedLeaves(user.id);
    const leaf = leaves.find((c) => c.id === req.params.id);
    if (!leaf) return res.status(404).json({ error: 'Leaf not found' });
    // Deleting the whole subtree, not just the leaf: orphaned children would be invisible on the
    // board (nothing renders them) while still counting against their root's budget.
    for (const descendant of subtreeOf(leaves, leaf.id)) {
      // Cancel before deleting: a workflow whose row is gone would keep running, and
      // UpdateLeafActivity would silently no-op forever against a leaf that no longer exists.
      await temporalBridge?.signalLeaf(descendant.id, 'cancelLeaf');
      await db.deleteLeaf(descendant.id);
    }
    await temporalBridge?.signalLeaf(leaf.id, 'cancelLeaf');
    await db.deleteLeaf(leaf.id);
    res.json({ success: true, deleted: subtreeOf(leaves, leaf.id).length + 1 });
  });

  /** ── MODULES ── */
  app.get('/api/modules', async (req, res) => res.json(await gitModuleService.listAvailableModules(req.query.appType as string)));

  /**
   * Settings schema for app types whose configuration is schema-driven rather than a handful of
   * first-class fields (see lib/app-settings-schema.ts). The frontend's Config tab renders itself
   * from this, so a new setting is a one-file backend change with no matching UI edit.
   *
   * Served over HTTP rather than shared as a module because there is no cross-workspace source
   * package here — adding one would mean rebuilding the in-cluster worker image too.
   */
  app.get('/api/app-schemas/:appType', async (req, res) => {
    const schema = APP_SETTINGS_SCHEMAS[req.params.appType];
    if (!schema) return res.status(404).json({ error: `No settings schema for app type "${req.params.appType}"` });
    return res.json(schema);
  });

  app.patch('/api/deployments/:id/modules', async (req, res) => {
    const { modules } = req.body;
    res.status(202).json(await appService.updateModules(req.params.id, modules, (req as any).user.id, io));
  });

  app.patch('/api/deployments/:id/storage', async (req, res) => {
    // Delegated to TemporalBridge (manual resize)
    try {
      if (!(await appService.getById(req.params.id, (req as any).user.id))) return res.status(404).json({ error: 'Deployment not found' });
      const info = await temporalBridge.resizeDisk(req.params.id, req.body.storage);
      res.status(202).json({
        message: 'Resize started',
        deploymentId: req.params.id,
        workflowId: info.id,
        state: 'running',
      });
    } catch (err: any) {
      res.status(503).json({ error: `Temporal resize disk unavailable: ${err.message}` });
    }
  });

  /**
   * What the resource ceilings resolve to when you leave them blank.
   *
   * Computed on demand rather than stored. A stored figure goes stale the moment the GPU count or
   * sequence length changes, and — worse — a persisted default would be sent on every deploy,
   * permanently overriding the very plan it came from. Blank has to keep meaning "size this for
   * me", so the number exists only to be SHOWN.
   *
   * The UI renders it as a placeholder, which is what makes an empty field read as "20G, computed
   * from the model" rather than as a missing value.
   */
  app.get('/api/deployments/:id/resource-plan', async (req, res) => {
    const user = (req as any).user;
    const dep = (await db.getDeployments()).find((d) => d.id === req.params.id && d.ownerId === user.id);
    if (!dep) return res.status(404).json({ error: 'Deployment not found' });
    if (dep.appType !== 'tabbyapi') return res.json({ applicable: false });

    // Non-fatal: a rate-limited lookup should cost the placeholder its precision, not the panel.
    let modelBytes: number | undefined;
    try {
      const { getHfModelSize } = await import('./lib/huggingface.js');
      modelBytes = (await getHfModelSize(dep.tabbyModel!, dep.tabbyRevision, dep.tabbyHfToken)).totalBytes;
    } catch { /* falls back to the conservative assumption inside the plan */ }

    let allocatableBytes: number | undefined;
    try {
      const nodes = await infraService.runCommand("kubectl", [
        'get', 'nodes', '-o', 'jsonpath={.items[*].status.allocatable.memory}',
      ], `resource-plan-${dep.id}`) as { stdout: string; exitCode: number };
      if (nodes.exitCode === 0) {
        const sizes = nodes.stdout.trim().split(/\s+/).map((q) => parseQuantity(q))
          .filter((n): n is number => n !== undefined);
        if (sizes.length) allocatableBytes = Math.min(...sizes);
      }
    } catch { /* no node reading means no budget, which the plan reports honestly */ }

    const plan = planHostMemory({
      modelBytes,
      gpuCount: Number(dep.tabbyGpuCount) || 1,
      maxSeqLen: Number(dep.tabbyMaxSeqLen) || TABBYAPI_DEFAULT_MAX_SEQ_LEN,
      inlineModelLoading: dep.tabbyInlineModelLoading === true,
      allocatableBytes,
    });

    res.json({
      applicable: true,
      memoryLimit: `${Math.ceil(plan.limitBytes / 1e9)}G`,
      shmSize: `${Math.ceil(plan.shmBytes / 1024 ** 3)}Gi`,
      // Not part of the memory plan — this is simply what the construct uses when nothing is set.
      cpuLimit: '10',
      basis: plan.basis,
      ...(plan.refusal ? { refusal: plan.refusal } : {}),
    });
  });

  app.patch('/api/deployments/:id/config', async (req, res) => {
    try {
      if (!(await appService.getById(req.params.id, (req as any).user.id))) return res.status(404).json({ error: 'Deployment not found' });
      // Allowlist rather than trusting req.body wholesale — this reaches saveDeploymentInfo(),
      // and fields like status/temporalWorkflowId are internal state a client should never be
      // able to overwrite directly.
      const CONFIGURABLE_FIELDS = [
        'storage', 'webRepo', 'webTag', 'dbRepo', 'dbTag',
        'vllmModel', 'vllmGpuCount', 'vllmGpuVendor', 'vllmCachePvc', 'vllmHfToken',
        'vllmMaxModelLen', 'vllmGpuMemUtil', 'vllmExtraArgs', 'openWebuiTargetId', 'hermesTargetId',
        'vllmToolCallingEnabled', 'vllmToolCallParser', 'vllmServedModelName',
        'vllmMaxNumSeqs', 'vllmDtype', 'vllmEnablePrefixCaching',
        'tabbyModel', 'tabbyRevision', 'tabbyGpuCount', 'tabbyHfToken', 'tabbyCachePvc',
        'tabbyImageTag', 'tabbyCacheMode', 'tabbyMaxSeqLen', 'tabbyMaxBatchSize',
        'tabbyReasoning', 'tabbyToolFormat', 'tabbyInlineModelLoading', 'tabbyDisableAuth',
        // Resource ceilings. Absent from this list, they were stripped here before anything else
        // saw them — so the UI offered three fields that could be edited, saved without complaint,
        // and changed nothing. The bridge and the activity both handle them; only this list did not.
        'tabbyMemoryLimit', 'tabbyShmSize', 'tabbyCpuLimit',
        'tabbyExtraEnv',
        'webuiEnableWebSearch', 'webuiWebSearchEngine', 'webuiWebSearchApiKey',
        // Map-valued: deep-merged in updateConfigAndSync and key-validated against the app's
        // schema below, since these become container env vars.
        'appSettings',
      ];
      const patch: Record<string, any> = {};
      for (const key of CONFIGURABLE_FIELDS) {
        if (req.body[key] !== undefined) patch[key] = req.body[key];
      }

      // The allowlist above gates FIELD names; it says nothing about the KEYS inside appSettings —
      // and those become container environment variables. Without this, any authenticated user
      // could inject arbitrary env (LD_PRELOAD and friends) into a pod. Validated here rather
      // than in the activity so the caller gets a synchronous 400 instead of a workflow that
      // fails minutes later.
      if (patch.appSettings !== undefined) {
        const existing = await appService.getById(req.params.id, (req as any).user.id);
        const schema = APP_SETTINGS_SCHEMAS[existing?.appType ?? ''];
        if (!schema) {
          return res.status(400).json({ error: `App type "${existing?.appType}" has no settings schema` });
        }
        const { values, errors } = validateAppSettings(schema, patch.appSettings);
        if (errors.length > 0) {
          return res.status(400).json({ error: 'Invalid settings', details: errors });
        }
        patch.appSettings = values;
      }

      const info = await temporalBridge.updateConfigAndSync(req.params.id, patch);
      res.status(202).json({
        message: 'Config updated, sync started',
        deploymentId: req.params.id,
        workflowId: info.id,
        state: 'running',
      });
    } catch (err: any) {
      res.status(503).json({ error: `Temporal config update unavailable: ${err.message}` });
    }
  });

  /** ── REGISTRY ── */
  app.get('/api/registry/search', async (req, res) => res.json(await registryService.search(req.query.q as string)));
  app.get('/api/registry/tags', async (req, res) => res.json(await registryService.getTags(req.query.repo as string)));
  app.get('/api/registry/local-tags', async (req, res) => res.json(await registryService.getLocalTags(req.query.repo as string)));

  // Lets the wizard show a model's real download size before deploying, instead of the
  // deploy-time regex guess in tabbyapi.ts (used only as a fallback there when this wasn't
  // available, e.g. an unusual repo name) — see DownloadModelActivity.ts for the shared file
  // -listing helper this also uses for the actual pre-download. Also estimates GPU VRAM (weight
  // shard + KV cache) for the requested context length/cache mode/GPU count, since that's a
  // separate concern from the download size and from the host-side shm/memory sizing tabbyapi.ts
  // does — see huggingface.ts's estimateKvCacheBytes for why this is informational, not a hard
  // validation gate (K8s' nvidia device plugin lets you request a GPU count, not a VRAM amount).
  app.get('/api/models/hf-size', async (req, res) => {
    try {
      const repo = req.query.repo as string;
      if (!repo) return res.status(400).json({ error: 'repo is required' });
      const revision = req.query.revision as string | undefined;
      const user = (req as any).user;
      const resolved = await credentialService.resolveCredentials(user.id, 'huggingface');
      const size = await getHfModelSize(repo, revision, resolved.env.HF_TOKEN);

      const maxSeqLen = req.query.maxSeqLen ? parseInt(req.query.maxSeqLen as string) : undefined;
      const gpuCount = Math.max(parseInt((req.query.gpuCount as string) || '1'), 1);
      let kvCacheBytesPerGpu: number | undefined;
      let weightBytesPerGpu: number | undefined;
      if (maxSeqLen) {
        try {
          const config = await getHfModelConfig(repo, revision, resolved.env.HF_TOKEN);
          kvCacheBytesPerGpu = estimateKvCacheBytes(config, maxSeqLen, req.query.cacheMode as string | undefined) / gpuCount;
          weightBytesPerGpu = size.totalBytes / gpuCount;
        } catch {
          // config.json missing/unparseable shouldn't block showing the download size — VRAM
          // estimate just gets omitted.
        }
      }

      res.json({ ...size, kvCacheBytesPerGpu, weightBytesPerGpu });
    } catch (err: any) {
      res.status(500).json({ error: err.response?.status === 404 ? `Model or revision not found: ${req.query.repo}@${req.query.revision || 'main'}` : err.message });
    }
  });

  // Backs the wizard's model picker for vLLM/TabbyAPI — an empty q still returns something
  // useful (top-downloaded results) rather than nothing, replacing what used to be a static
  // hardcoded list of 4-5 models baked into the frontend. TabbyAPI only runs EXL3 quants, so its
  // results come from turboderp's curated exl3-models collection instead of generic search —
  // see getExl3ModelCollection's own comment for why.
  app.get('/api/models/search', async (req, res) => {
    try {
      const q = (req.query.q as string) || '';
      const appType = req.query.appType as string;
      const results = appType === 'tabbyapi'
        ? await getExl3ModelCollection(q)
        : await searchHfModels(q, { ...(appType === "vllm" ? { pipelineTag: "text-generation" } : {}), limit: 20 });
      res.json(results);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Lets the wizard show which bits-per-weight branches actually exist for a picked model —
  // see getHfModelBranches's own comment for why this is a separate lookup from the model
  // picker itself (EXL2/EXL3 quants split bpw variants across branches of one repo).
  app.get('/api/models/hf-branches', async (req, res) => {
    try {
      const repo = req.query.repo as string;
      if (!repo) return res.status(400).json({ error: 'repo is required' });
      const user = (req as any).user;
      const resolved = await credentialService.resolveCredentials(user.id, 'huggingface');
      const branches = await getHfModelBranches(repo, resolved.env.HF_TOKEN);
      res.json(branches);
    } catch (err: any) {
      res.status(500).json({ error: err.response?.status === 404 ? `Model not found: ${req.query.repo}` : err.message });
    }
  });

  /** ── NGINX config ── */
  const NGINX_CONF_PATH = path.join(__dirname, '../data/nginx/nginx.conf');

  app.get('/api/nginx/config', async (req, res) => {
    try { res.json({ content: await fs.readFile(NGINX_CONF_PATH, 'utf-8') }); }
    catch (err: any) { res.status(500).json({ error: `Failed to read nginx config: ${err.message}` }); }
  });

  app.post('/api/nginx/config', async (req, res) => {
    try {
      const { content } = req.body;
      if (typeof content !== 'string') return res.status(400).json({ error: 'Config content must be a string' });
      await fs.writeFile(NGINX_CONF_PATH, content);

      const execAsync = (await import('util')).promisify((await import('child_process')).exec);
      await execAsync('docker exec provisioner-nginx nginx -s reload');
      res.json({ message: 'Nginx config updated and reloaded successfully' });
    } catch (err: any) { res.status(500).json({ error: `Failed to update nginx config: ${err.message}` }); }
  });

  /** ── LOGS ── */
  app.get('/api/logs/:type/:id', async (req, res) => {
    const { type, id } = req.params;
    const resource = type === 'cluster'
      ? await clusterService.getById(id, (req as any).user.id)
      : type === 'pipeline'
      ? (await db.getPipelineRuns()).find((r: any) => r.id === id)
      : (await appService.getAll((req as any).user.id)).find((d: any) => d.id === id);
    const logPath = type === 'pipeline' ? (resource as any)?.logFile : (resource as any)?.lastLogPath;
    if (!resource || !logPath) return res.json({ content: 'Initializing...' });
    try {
      const content = await fs.readFile(logPath, 'utf-8');
      res.json({ content });
    }
    catch {
      res.json({ content: 'Waiting for logs...' });
    }
  });

  /** ── TEMPORAL — monitoring ── */

  app.get('/api/temporal/status', async (req, res) => {
    const ready = temporalBridge.isReady();
    let version: string | undefined;
    if (ready) {
      try {
        const svc = (temporalBridge as any).client.workflowService;
        const info = await svc?.getSystemInfo?.();
        version = info?.serverVersion;
      } catch {}
    }
    res.json({ connected: ready, serverVersion: version });
  });

  app.get('/api/temporal/workflows', async (req, res) => {
    const query = req.query.query as string | undefined;
    const pageSize = parseInt(req.query.pageSize as string, 10) || 50;
    const workflows = await temporalBridge.listWorkflows(query, pageSize);
    res.json({ workflows });
  });

  app.get('/api/temporal/workflows/count', async (req, res) => {
    const [total, running, completed, failed, timedOut] = await Promise.all([
      temporalBridge.countWorkflows(''),
      temporalBridge.countWorkflows('ExecutionStatus="Running"'),
      temporalBridge.countWorkflows('ExecutionStatus="Completed"'),
      temporalBridge.countWorkflows('ExecutionStatus="Failed"'),
      temporalBridge.countWorkflows('ExecutionStatus="TimedOut"'),
    ]);
    res.json({ total, running, completed, failed, timedOut });
  });

  app.get('/api/temporal/workflows/:workflowId', async (req, res) => {
    const workflow = await temporalBridge.describeWorkflow(req.params.workflowId);
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' });
    res.json({ workflow });
  });

  app.get('/api/temporal/workflows/:workflowId/history', async (req, res) => {
    const events = await temporalBridge.getWorkflowHistory(req.params.workflowId);
    if (!events) return res.status(404).json({ error: 'Workflow not found' });
    res.json({ events });
  });

  /** ── INIT ── */
  if (process.env.NODE_ENV !== 'test') {
    appExposureService.syncExposedApps().catch((e) => {
      const err = e instanceof Error ? e.message : String(e);
      console.error(`Failed to sync exposed apps to nginx: ${err}`);
    });
  }

  // ── WORKER ──

  const workerService = new WorkerService();

  app.post('/api/worker', async (req, res) => {
    try {
      const { clusterId, context } = req.body || {};
      if (!clusterId) return res.status(400).json({ error: 'clusterId is required' });
      console.log(`[Worker] Initialized worker ${clusterId} (context: ${context || 'local'})`);
      res.status(202).json({
        message: 'Worker initialized',
        clusterId,
        context: context || 'local',
        state: 'running',
      });
    } catch (err: any) {
      console.error(`[Worker] Failed to initialize: ${err.message}`);
      res.status(503).json({ error: err.message });
    }
  });

  app.delete('/api/worker', async (req, res) => {
    try {
      console.log('[Worker] Worker stopped');
      res.status(200).json({ message: 'Worker stopped' });
    } catch (err: any) {
      console.error(`[Worker] Failed to stop: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/worker', async (req, res) => {
    try {
      const state = workerService.status();
      res.json({
        clusterId: state?.clusterId || '',
        context: state?.context || 'local',
        state: state?.state || 'stopped',
        running: state?.state === 'running',
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

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

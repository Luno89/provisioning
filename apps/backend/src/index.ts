import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';

const LOG_TAIL_LINES = 200;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { Server as SocketServer } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';

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
import { packsRouter } from './routes/packs.js';
import { authRouter } from './routes/auth.js';
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
import { seedPersonas } from './lib/persona-seeds.js';
import { validateSpec, explainSpecProblems } from './lib/app-spec-validate.js';
import { hollowChecks, explainHollow } from './lib/acceptance-validation.js';
import type { AcceptanceCheck } from './lib/acceptance.js';
import { chatMcpFor, NO_CHAT_MCP } from './lib/chat-mcp.js';
import {
  titleFrom, enabledForSession, MAX_TOOL_CALL_ARGS, MAX_TOOL_CALL_DIGEST, MAX_TOOL_CALLS_PER_MESSAGE,
  type Conversation, type ProposedTree, type ConversationToolCall,
} from './lib/conversations.js';
import { buildKoalaPrompt } from './lib/koala-persona.js';
import { seedTools } from './lib/tool-seeds.js';
import { seedPacks } from './lib/pack-seeds.js';
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

export async function bootstrap(): Promise<{ app: express.Application; io: SocketServer; temporalBridge?: TemporalBridge }> {
  const app = express();
  const httpServer = createServer(app);
  const port = process.env.PORT || 3001;

  const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, '');

  const APP_URL = (process.env.APP_URL || process.env.PUBLIC_URL || 'http://localhost:5173').replace(/\/$/, '');

  const corsAllowed = new Set([PUBLIC_URL, APP_URL]);
  const originAllowed = (origin: string | undefined): boolean =>
    !origin || process.env.NODE_ENV !== 'production' || corsAllowed.has(origin.replace(/\/$/, ''));

  const io = new SocketServer(httpServer, {
    cors: {
      origin: (origin, cb) => cb(null, originAllowed(origin)),
      credentials: true,
    },
  });

  const db = createDatabase();
  await db.init();
  await migrateLegacyOwnership(db);
  await seedTools(db);
  await seedBindingTypes(db);
  await seedPersonas(db).then(
    (n) => n && console.log(`[personas] seeded ${n} built-in persona(s)`),
    (err: Error) => console.warn(`[personas] could not seed: ${err.message}`),
  );
  await seedPacks(db).then(
    (n) => n && console.log(`[packs] seeded ${n} built-in pack(s)`),
    (err: Error) => console.warn(`[packs] could not seed: ${err.message}`),
  );

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

  const modelIdsFor = async (userId: string): Promise<string[] | undefined> => {
    try {
      return (await modelService.list(userId)).map((m) => m.id);
    } catch {
      return undefined;
    }
  };

  const experimentService = new ExperimentService(
    db, modelService, undefined, io, executeWebSearch, executeFetchWebPage,
  );
  const authoringService = new AuthoringService();
  const workbenchService = new WorkbenchService();

  workbenchService.sweepOrphans()
    .then((ids) => ids.length && console.log(`[bootstrap] Swept ${ids.length} orphaned workbench pod(s)`))
    .catch((err: any) => console.warn(`[bootstrap] Workbench sweep failed: ${err.message}`));

  experimentService.reconcileInterrupted()
    .then((n) => n && console.log(`[bootstrap] Closed out ${n} experiment(s) interrupted by a restart`))
    .catch((err: any) => console.warn(`[bootstrap] Experiment reconcile failed: ${err.message}`));

  clusterService.ensureSystemClusterGpuReady().catch((err: any) =>
    console.warn(`[bootstrap] System cluster GPU readiness check failed: ${err.message}`)
  );

  const temporalBridge = new TemporalBridge(db, io, JWT_SECRET, clusterService, headscaleService);
  clusterService.setTemporalBridge(temporalBridge);
  appService.setTemporalBridge(temporalBridge);
  try {
    await temporalBridge.start();
    await temporalBridge.startActiveWorkflowRecovery();
  } catch (e: any) {
    console.warn(`⚠️ Temporal TS bridge not available. Routes will fall back to Local DB.`, e.message);
  }

  const authService = new AuthService(db);
  app.use(cors({
    origin: (origin, callback) => callback(null, originAllowed(origin)),
    credentials: true,
  }));

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

      const defaultBranch = String(payload.repository?.default_branch ?? 'main');
      if (ref !== defaultBranch) {
        return res.status(200).json({ status: 'ignored', reason: `not the default branch (${ref} != ${defaultBranch})` });
      }

      res.status(202).json({ status: 'accepted' });
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

  const auth = createAuth({ db, jwtSecret: JWT_SECRET, publicUrl: PUBLIC_URL });
  const { requireAdmin, userFromSessionCookie } = auth;

  app.use('/api', auth.requireAuth);

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

  async function authorizeRoom(user: UserMetadata | undefined, id: string): Promise<any | undefined> {
    if (!user) return undefined;
    const cluster = await clusterService.getById(id, user.id);
    if (cluster) return cluster;
    const deployment = await appService.getById(id, user.id);
    if (deployment) return deployment;
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
      const dep = await appService.getById(resourceId, user.id);
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

  app.use('/api/auth', authRouter({
    db, authService, auth, jwtSecret: JWT_SECRET, publicUrl: PUBLIC_URL, appUrl: APP_URL,
  }));

  app.get('/ingress/verify', async (req, res) => {
    const domain = String(req.query.domain ?? '');
    if (!domain) return res.status(400).send('domain required');
    const deployments = await db.getDeployments();
    const owned = deployments.some((d) => d.isExposedPublicly && d.publicHostname === domain);
    return owned ? res.status(200).send('ok') : res.status(404).send('unknown host');
  });

  app.use('/api/credentials', credentialsRouter({
    credentialService,
    publicUrl: PUBLIC_URL,
    appUrl: APP_URL,
  }));
  app.use('/api/backup', backupRouter({ repoRoot: path.join(__dirname, '../../..') }));

  app.use('/api/clusters', clustersRouter({
    clusterService, appService, clusterProxyService, infraService,
    temporalBridge, db, io, giteaService, jwtSecret: JWT_SECRET,
  }));
  app.use('/api/deployments', deploymentsRouter({
    appService, clusterService, appExposureService, infraService, temporalBridge, db, io,
  }));

  const getOwnedProject = async (id: string, user: any): Promise<any | undefined> => {
    const project = (await db.getProjects()).find((p: any) => p.id === id);
    return project && ownsProject(project, user) ? project : undefined;
  };

  async function webTools() {
    return resolveWebTools({
      db,
      ensurePortForward: (clusterId, serviceKey, kubeconfigPath, target) =>
        clusterProxyService.ensurePortForward(clusterId, serviceKey, kubeconfigPath, target),
      kubeconfigFor: async (clusterId: string) => {
        const cluster = await clusterService.getByIdUnscoped(clusterId);
        return cluster ? clusterService.getKubeconfigPath(cluster) : undefined;
      },
    });
  }

  async function executeWebSearch(query: string): Promise<SearchOutcome> {
    return (await webTools()).search(query);
  }

  async function executeFetchWebPage(url: string): Promise<string> {
    return (await webTools()).fetchPage(url);
  }

  function toolRefused(result: string): boolean {
    try {
      return Boolean(JSON.parse(result)?.error);
    } catch {
      return true;
    }
  }

  const ownedPersonas = async (userId: string): Promise<Persona[]> =>
    (await db.getPersonas()).filter((p) => p.ownerId === userId);

  async function runLeafTool(userId: string, branchId: string, call: { name: string; arguments: string }): Promise<string> {
    return runLeafToolShared(
      {
        db,
        userId,
        branchId,
        webSearch: executeWebSearch,
        fetchWebPage: executeFetchWebPage,
        projects: projectRepoService,
        ...(temporalBridge
          ? {
              ingest: {
                start: (a: Parameters<typeof temporalBridge.startIngest>[0]) => temporalBridge.startIngest(a),
                status: (id: string) => temporalBridge.ingestStatus(id),
                search: (a: { ownerId: string; query: string; ingestId?: string }) => SearchCorpusActivity(a),
              },
            }
          : {}),
        mcpRegistry: new McpRegistryService(db, userId, (name: string) => resolveMcpProbeUrl(name)),
      },
      call,
    );
  }

  app.get('/api/harness/config', async (req, res) => {
    const userId = (req as any).user.id;
    const profile = await db.getHarnessProfile(userId);

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

  app.get('/api/harness/export', async (req, res) => {
    const userId = (req as any).user.id;
    const mine = (await db.getExperiments()).filter((e) => e.ownerId === userId);
    res.json(buildConfigExport(mine, await db.getHarnessProfile(userId)));
  });

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
      const invalid = validateExperiment(draft);
      if (invalid) { failed.push(`${suite.name}: ${invalid}`); continue; }
      await db.saveExperiment(draft);
      created.push(draft.name);
    }
    res.json({ created, failed, rejected: parsed.rejected });
  });

  const ownedBranches = async (userId: string) => ownedBy(await db.getBranches(), userId);
  const ownedLeaves = async (userId: string) => ownedBy(await db.getLeaves(), userId);
  const ownedTrees = async (userId: string) => ownedBy(await db.getTrees(), userId);

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

  const NGINX_CONF_PATH = path.join(__dirname, '../data/nginx/nginx.conf');

  const workerService = new WorkerService();

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

  const ownedConversations = async (userId: string) =>
    (await db.getConversations()).filter((c) => c.ownerId === userId);

  app.use('/api/chat-pack', personaChatRouter({
    db, modelService,
    projectRepoService,
    temporalBridge,
    infraService,
    infisicalService,
    jwtSecret: JWT_SECRET,
    personaFor: async (userId, personaId) =>
      (await ownedPersonas(userId)).find((p) => p.id === personaId),
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
  app.use('/api/personas', personasRouter({ db, modelIdsFor }));
  app.use('/api/persona-options', personaOptionsRouter({ db, modelIdsFor }));
  app.use('/api/packs', packsRouter({ db, modelIdsFor }));

  app.use('/api/tree-types', treeTypesRouter({ db }));
  app.use('/api/binding-types', bindingTypesRouter({ db }));
  app.use('/api/trees', treesRouter({ db, temporalBridge }));
  app.use('/api/branches', branchesRouter({ db, temporalBridge }));

  async function koalaServers(userId: string) {
    try {
      const registry = new McpRegistryService(db, userId, (n: string) => resolveMcpProbeUrl(n));
      return preferUsable(await registry.listWithTools());
    } catch (err: any) {
      console.warn(`[koala] could not list services: ${err.message}`);
      return [];
    }
  }

  app.use('/api/leaves', leavesRouter({ db, temporalBridge, giteaService }));

  if (process.env.NODE_ENV !== 'test') {
    appExposureService.syncExposedApps().catch((e) => {
      const err = e instanceof Error ? e.message : String(e);
      console.error(`Failed to sync exposed apps to nginx: ${err}`);
    });
  }

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

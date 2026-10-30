import path from 'path';
import fs from 'fs/promises';
import type express from 'express';
import type { Server as SocketServer } from 'socket.io';
import {
  type Database, type SecretKey, allowed, holdsAccounts, servesTenants, signsInThroughRoot, type RoleConfig, startedFor,
  getTemporalClient, type mongoTarget, type MailService, type createAuth, claimSettingsFrom, operatorsAmong, PLATFORM_OWNER, publicFetch, keepTrying,
} from '../../platform/index.js';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/common';
import { poolSettingsFrom } from '../lib/pool.js';
import type { InstanceRecord } from '../lib/instances.js';
import { issueMoveToken, type UsedTokenClaim } from '../lib/identity-token.js';
import { MOVE_FINISHED, MOVE_STOPPED, answersWhileMoving, poolMoveWorkflowId } from '../lib/instance-move.js';
import { poolRemoveWorkflowId, poolTrialWorkflowId, TRIAL_CHANGED } from '../lib/pool-trial.js';
import { HUB_AUDIENCE, hubInstancePart, type Mounts } from '../../hub/index.js';
import type { IdentityService } from '../services/IdentityService.js';
import { InstanceService } from '../services/InstanceService.js';
import { InstanceRoutes, dockerCaddy, socketCaddy } from '../services/InstanceRoutes.js';
import { InstanceAddresses, adminEdge } from '../services/InstanceAddresses.js';
import { InstanceTrial } from '../services/InstanceTrial.js';
import { InstanceUpdates } from '../services/InstanceUpdates.js';
import { InstanceChart, releaseInventory } from '../services/InstanceChart.js';
import { ReleaseCatalogue } from '../services/ReleaseCatalogue.js';
import { DependencyWatch } from '../services/DependencyWatch.js';
import { DEPENDENCY_WATCH_ID } from '../lib/dependency-findings.js';
import { WithdrawalNotices } from '../services/WithdrawalNotices.js';
import { MoveExport } from '../services/MoveExport.js';
import { MoveRelay, kubeconfigFile } from '../services/MoveRelay.js';
import { PoolMonitoringService } from '../services/PoolMonitoringService.js';
import { InstanceMailLimit } from '../services/InstanceMailLimit.js';
import { InstancePresence } from '../services/InstancePresence.js';
import { InstanceWatchSetting } from '../services/InstanceWatchSetting.js';
import { RootPresence, type RootReachView } from '../services/RootPresence.js';
import { instanceWatchRouter } from '../routes/instance-watch.js';
import { PRESENCE_NAMESPACE, presenceAuth, unreachableAfterMs } from '../lib/instance-watch.js';
import type { InstanceEdge, HeadscaleService, InfrastructureService } from '../../infrastructure/index.js';
import { identityRouter } from '../routes/identity.js';
import { signInRouter } from '../routes/sign-in.js';
import { oidcProviderRouter } from '../routes/oidc-provider.js';
import type { RootProvider } from '../services/RootProvider.js';
import type { RootSignIn } from '../services/RootSignIn.js';
import { OIDC_PATH } from '../lib/oidc.js';
import { instancesRouter } from '../routes/instances.js';
import { instanceTrialRouter } from '../routes/instance-trial.js';
import { instanceAddressesRouter } from '../routes/instance-addresses.js';
import { instanceUpdatesRouter } from '../routes/instance-updates.js';
import { moveRouter } from '../routes/move.js';
import type { Routes } from '../../machines/index.js';

const POOL_KUBECONFIG = '/tmp/kubeconfig-provisioning-lunorica';

export class InstanceSide {
  readonly edge: InstanceEdge | undefined;
  private addresses: InstanceAddresses | undefined;
  private rootPresence: RootPresence | undefined;

  constructor(private readonly role: RoleConfig, private readonly env: NodeJS.ProcessEnv, private readonly rootToken: (() => Promise<string>) | undefined) {
    const name = env.INSTANCE_NAME;
    this.edge = role.instance && name && env.EDGE_ADMIN_URL && env.EDGE_CADDYFILE
      ? adminEdge(name, env.EDGE_ADMIN_URL, env.EDGE_CADDYFILE, () => this.addresses)
      : undefined;
  }

  follow(republish: () => Promise<void>): void {
    if (!this.edge || !this.role.instance || !this.rootToken) return;
    this.addresses = new InstanceAddresses(
      { rootUrl: this.role.instance.rootUrl, instanceId: this.role.instance.id, token: this.rootToken, name: this.edge.name },
      republish,
    );
    this.addresses.refresh().catch((err: Error) => console.warn(`[addresses] ${err.message}`));
  }

  current(): InstanceAddresses | undefined {
    return this.addresses;
  }

  watchRoot(tell: (ownerId: string, message: { title: string; body: string; path: string; tag: string }) => Promise<unknown>): void {
    if (!this.role.instance || !this.rootToken || this.rootPresence) return;
    this.rootPresence = new RootPresence({
      rootUrl: this.role.instance.rootUrl,
      instanceId: this.role.instance.id,
      ownerId: this.role.instance.ownerId,
      token: this.rootToken,
      tell,
      afterMs: unreachableAfterMs(this.env),
    });
    this.rootPresence.start();
  }

  rootReach(): RootReachView | undefined {
    return this.rootPresence?.view();
  }
}

export interface MoveExportDeps {
  role: RoleConfig;
  env: NodeJS.ProcessEnv;
  app: Routes;
  dataDir: string;
  mongo: ReturnType<typeof mongoTarget>;
  running: () => Promise<string[] | 'unknown'>;
  claim: UsedTokenClaim;
}

export async function wireMoveExport(deps: MoveExportDeps): Promise<MoveExport | undefined> {
  const { role, env } = deps;
  if (!(role.role === 'instance' && env.POOL === 'true' && role.trusted && role.instance)) return undefined;
  const moveExport = new MoveExport({
    instanceId: role.instance.id,
    trusted: role.trusted,
    dataDir: deps.dataDir,
    mongo: deps.mongo,
    env,
    running: deps.running,
    claim: deps.claim,
  });
  await moveExport.load();
  const frozen: express.RequestHandler = (req, res, next) => (moveExport.isFrozen() && !answersWhileMoving(req.path)
    ? res.status(503).json({ error: 'This instance is moving to your own machine; it opens there once the move is done' })
    : next());
  deps.app.use('/api', frozen);
  deps.app.use('/api/move', moveRouter({ move: moveExport, log: (message) => console.warn(message) }));
  return moveExport;
}

export interface InstancesWiringDeps {
  role: RoleConfig;
  env: NodeJS.ProcessEnv;
  app: Routes;
  tenant: Mounts;
  db: Database;
  mail: MailService;
  identity: IdentityService;
  auth: Pick<ReturnType<typeof createAuth>, 'requireOperator' | 'principalFor' | 'userFromSessionCookie' | 'securedFor' | 'setSessionCookie' | 'getCookie' | 'sessionCookieOptions'>;
  sessionKey: SecretKey;
  publicUrl: string;
  repoRoot: string;
  dataDir: string;
  headscale: HeadscaleService;
  infra: Pick<InfrastructureService, 'runKubectl' | 'applyManifest'>;
  side: InstanceSide;
  syncExposedApps: () => Promise<void>;
  provider?: RootProvider | undefined;
  signIn?: RootSignIn | undefined;
  rootToken?: (() => Promise<string>) | undefined;
  io: SocketServer;
}

export interface InstancesWiring {
  instanceService: InstanceService | undefined;
}

export async function wireInstances(deps: InstancesWiringDeps): Promise<InstancesWiring> {
  const { role, env, app, tenant, db, identity, publicUrl } = deps;
  deps.side.follow(deps.syncExposedApps);

  if (holdsAccounts(role)) {
    app.use('/api/identity', identityRouter({ identity, servesTenants: servesTenants(role), signedIn: (req) => deps.auth.userFromSessionCookie(req.headers.cookie, deps.auth.securedFor(req)), reachOf: async (instanceId) => (await db.instances.getWatch(instanceId))?.reach }));
  }
  if (deps.provider) {
    const provider = deps.provider;
    app.use(OIDC_PATH, oidcProviderRouter({ provider, signedIn: (req) => deps.auth.userFromSessionCookie(req.headers.cookie, deps.auth.securedFor(req)) }));
    void provider.deliverLogouts();
    setInterval(() => { void provider.deliverLogouts(); }, 30_000);
  }
  if (signsInThroughRoot(role.role) && deps.signIn) {
    await deps.signIn.load();
    deps.signIn.keepAnnouncing((message) => console.warn(`[sign-in] ${message}`));
    app.use('/api/auth', signInRouter({ signIn: deps.signIn, identity, auth: deps.auth, publicUrl, landing: role.role === 'hub' ? '/shared' : '/chat' }));
  }

  tenant.use('/api/instance-addresses', instanceAddressesRouter({ addresses: () => deps.side.current() }));
  tenant.use('/api/instance-watch', instanceWatchRouter({
    setting: role.instance && deps.rootToken
      ? new InstanceWatchSetting({ rootUrl: role.instance.rootUrl, instanceId: role.instance.id, token: deps.rootToken })
      : undefined,
  }));
  tenant.use('/api/instance-trial', instanceTrialRouter({
    trial: role.instance && deps.rootToken
      ? new InstanceTrial({ rootUrl: role.instance.rootUrl, instanceId: role.instance.id, token: deps.rootToken })
      : undefined,
  }));

  tenant.use('/api/instance-updates', instanceUpdatesRouter({
    updates: role.instance && deps.rootToken
      ? new InstanceUpdates(
        { rootUrl: role.instance.rootUrl, instanceId: role.instance.id, token: deps.rootToken, cronJob: env.SELF_UPGRADE_CRONJOB, namespace: env.INSTANCE_NAMESPACE },
        async (args) => String(await deps.infra.runKubectl(args)),
      )
      : undefined,
  }));

  if (!holdsAccounts(role)) return { instanceService: undefined };

  const instanceChart = new InstanceChart(deps.repoRoot);
  const releaseCatalogue = new ReleaseCatalogue(db.instances, {
    repoRoot: deps.repoRoot,
    chartsDir: path.join(deps.dataDir, 'instance-charts'),
    imageTag: env.INSTANCE_IMAGE_TAG || 'dev',
    imageDigest: env.INSTANCE_IMAGE_DIGEST,
    chart: () => instanceChart.path(),
    inventory: (release, out) => releaseInventory(deps.repoRoot, release, out),
  });
  const withdrawalNotices = new WithdrawalNotices(db.instances, deps.mail, env.INSTANCE_IMAGE_TAG || 'dev');
  releaseCatalogue.recordCurrent()
    .then(() => withdrawalNotices.tell())
    .catch((err: Error) => console.error(`[releases] could not record the release root runs: ${err.message}`));
  const routingDomain = env.INGRESS_DOMAIN || undefined;
  const instanceRoutes = routingDomain
    ? new InstanceRoutes(db.instances, routingDomain, path.join(deps.dataDir, 'caddy'), (env.CADDY_ADMIN_SOCKET
      ? socketCaddy(env.CADDY_ADMIN_SOCKET, env.CADDY_CONFIG || path.join(deps.repoRoot, 'Caddyfile'), env.CADDY_LOG || '/var/log/koala-caddy/caddy.log', env.CADDY_TLS_ADDRESS || '127.0.0.1:443')
      : dockerCaddy(env.CADDY_CONTAINER || 'nowrinkles-caddy', env.CADDY_TLS_ADDRESS || '127.0.0.1:443')), (message) => console.error(message))
    : undefined;
  const siteNames = [env.APP_DOMAIN, env.MESH_DOMAIN]
    .filter((site): site is string => Boolean(site && routingDomain && site.endsWith(`.${routingDomain}`)))
    .map((site) => site.slice(0, -(routingDomain!.length + 1)));
  const poolTaskQueue = env.POOL_TASK_QUEUE || 'host-ops-queue';
  const dependencyWatch = new DependencyWatch({
    store: db.instances,
    inventoryOf: async (tag) => {
      const file = releaseCatalogue.inventoryFile(tag);
      if (!file) return undefined;
      try {
        return JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
      } catch {
        return undefined;
      }
    },
    currentRelease: env.INSTANCE_IMAGE_TAG || 'dev',
    fetchImpl: publicFetch,
    tell: async (message) => {
      for (const operator of operatorsAmong(await db.accounts.getUsers(), claimSettingsFrom(role))) {
        await deps.mail.toOwner(operator.id, message).catch((error: Error) => console.warn(`[dependencies] could not email ${operator.id} "${message.subject}": ${error.message}`));
      }
    },
    rootUrl: publicUrl,
  });
  void keepTrying('[dependencies] the daily check has not started yet', async () => {
    try {
      await (await getTemporalClient()).workflow.start('DependencyWatchWorkflow', {
        workflowId: DEPENDENCY_WATCH_ID,
        taskQueue: poolTaskQueue,
        args: [],
        ...startedFor(PLATFORM_OWNER),
      });
    } catch (error) {
      if (error instanceof WorkflowExecutionAlreadyStartedError) return;
      const { message, cause } = error as Error & { cause?: unknown };
      throw new Error(cause instanceof Error ? `${message}: ${cause.message}` : message);
    }
  }, (message) => console.warn(message));
  const pool = poolSettingsFrom(env, POOL_KUBECONFIG);
  let presenceOf: ((instanceId: string) => boolean) | undefined;
  const instanceService = new InstanceService(db, {
    connected: (instanceId) => presenceOf?.(instanceId) ?? false,
    rootUrl: publicUrl,
    rootPublicKeys: () => identity.publicKeys().map((key) => key.publicKey),
    meshLoginServer: env.MESH_LOGIN_SERVER,
    registry: env.INSTANCE_REGISTRY ?? '',
    imageTag: env.INSTANCE_IMAGE_TAG || 'dev',
    releases: releaseCatalogue,
    domain: routingDomain,
    siteNames,
    pool: 'off' in pool ? pool : { slots: pool.slots, trialDays: pool.trialDays },
    serviceCaller: deps.provider ? (token) => deps.provider!.serviceCaller(token) : undefined,
  }, deps.headscale, () => new Date(), () => instanceRoutes?.changed(), {
    start: async (instanceId, ownerId) => {
      await (await getTemporalClient()).workflow.start('PoolInstanceWorkflow', {
        workflowId: `pool-instance-${instanceId}`,
        taskQueue: poolTaskQueue,
        args: [{ instanceId }],
        ...startedFor(ownerId),
      });
    },
    trialChanged: async (instanceId) => {
      await (await getTemporalClient()).workflow.getHandle(poolTrialWorkflowId(instanceId)).signal(TRIAL_CHANGED).catch((error: Error) => {
        if (!/not found|already completed/i.test(error.message)) throw error;
      });
    },
    remove: async (instanceId, ownerId) => {
      await (await getTemporalClient()).workflow.start('PoolRemoveWorkflow', {
        workflowId: poolRemoveWorkflowId(instanceId),
        taskQueue: poolTaskQueue,
        args: [{ instanceId }],
        ...startedFor(ownerId),
      });
    },
    move: async (instanceId, ownerId) => {
      await (await getTemporalClient()).workflow.start('PoolMoveWorkflow', {
        workflowId: poolMoveWorkflowId(instanceId),
        taskQueue: poolTaskQueue,
        args: [{ instanceId }],
        workflowIdReusePolicy: 'ALLOW_DUPLICATE',
        ...startedFor(ownerId),
      });
    },
    moveFinished: async (instanceId) => {
      await (await getTemporalClient()).workflow.getHandle(poolMoveWorkflowId(instanceId)).signal(MOVE_FINISHED);
    },
    moveStopped: async (instanceId, reason) => {
      await (await getTemporalClient()).workflow.getHandle(poolMoveWorkflowId(instanceId)).signal(MOVE_STOPPED, reason);
    },
  });
  instanceRoutes?.start();
  if (role.role === 'root') {
    const presence = new InstancePresence({
      store: db.instances,
      tellOwner: (ownerId, message) => deps.mail.toOwner(ownerId, message),
      tellOperators: async (message) => {
        const operators = (await db.accounts.getUsers()).filter((user) => !user.space && allowed(deps.auth.principalFor(user), 'administer', { kind: 'install' }));
        for (const operator of operators) await deps.mail.toOwner(operator.id, message);
      },
      afterMs: unreachableAfterMs(env),
    });
    presenceOf = (instanceId) => presence.connected(instanceId);
    wireInstancePresence(deps.io, presence, (instanceId, token) => instanceService.presenceCaller(instanceId, token));
    presence.start().catch((err: Error) => console.warn(`[instance-presence] ${err.message}`));
  }

  const poolMonitoring = 'off' in pool ? undefined : new PoolMonitoringService({
    kubectl: async (args) => String(await deps.infra.runKubectl(args, pool.kubeconfig)),
    apply: async (manifest) => { await deps.infra.applyManifest(manifest, pool.kubeconfig); },
  });
  const moveRelay = 'off' in pool || !role.signing ? undefined : new MoveRelay({
    kubeconfig: kubeconfigFile(pool.kubeconfig),
    sign: (instanceId, part) => issueMoveToken(role.signing!, instanceId, part),
  });
  const hubAccess = role.signing && role.hubLink
    ? async (instanceId: string, ownerId: string) => {
      const owner = await db.accounts.getUserById(ownerId);
      if (!owner) return undefined;
      return { token: issueMoveToken(role.signing!, HUB_AUDIENCE, hubInstancePart(instanceId, ownerId, owner.email)), hubUrl: role.hubLink!.url, personId: ownerId, email: owner.email, instanceId };
    }
    : undefined;
  app.use('/api/instances', instancesRouter({ instances: instanceService, mailLimit: new InstanceMailLimit(), chart: () => instanceChart.path(), chartOf: (imageTag) => releaseCatalogue.chartFile(imageTag), mail: deps.mail, operatorOnly: deps.auth.requireOperator('manage-accounts'), administers: deps.auth.requireOperator('administer'), dependencies: dependencyWatch, poolMonitoring, moveRelay, hubAccess }));
  const installer = (await fs.readFile(path.join(deps.repoRoot, 'scripts/instance/install.sh'), 'utf8')).replace('__ROOT_URL__', publicUrl);
  app.get('/install.sh', (_req, res) => res.type('text/x-shellscript').send(installer));
  app.get('/install/setup-gpu.sh', (_req, res) => res.type('text/x-shellscript').sendFile(path.join(deps.repoRoot, 'scripts/setup-gpu.sh')));
  return { instanceService };
}

export function wireInstancePresence(
  io: Pick<SocketServer, 'of'>,
  presence: Pick<InstancePresence, 'arrived' | 'left'>,
  caller: (instanceId: string, token: string) => Promise<InstanceRecord | undefined>,
): void {
  const namespace = io.of(PRESENCE_NAMESPACE);
  namespace.use((socket, next) => {
    const auth = presenceAuth(socket.handshake.auth);
    if (!auth) return next(new Error('Unauthorized'));
    caller(auth.instanceId, auth.token).then((instance) => {
      if (!instance) return next(new Error('Unauthorized'));
      socket.data.instance = instance;
      next();
    }, () => next(new Error('Unauthorized')));
  });
  namespace.on('connection', (socket) => {
    const instance = socket.data.instance as InstanceRecord;
    void presence.arrived(instance, socket.id);
    socket.on('disconnect', () => { void presence.left(instance.id, socket.id); });
  });
}

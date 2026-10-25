import path from 'path';
import fs from 'fs/promises';
import type express from 'express';
import {
  type Database, type SecretKey, holdsAccounts, servesTenants, signsInThroughRoot, type RoleConfig, startedFor,
  getTemporalClient, type mongoTarget, type MailService, type createAuth,
} from '../../platform/index.js';
import { poolSettingsFrom } from '../lib/pool.js';
import { issueMoveToken } from '../lib/identity-token.js';
import { MOVE_FINISHED, MOVE_STOPPED, answersWhileMoving, poolMoveWorkflowId } from '../lib/instance-move.js';
import { poolRemoveWorkflowId, poolTrialWorkflowId, TRIAL_CHANGED } from '../lib/pool-trial.js';
import { HUB_AUDIENCE, hubInstancePart, type Mounts } from '../../hub/index.js';
import type { IdentityService } from '../services/IdentityService.js';
import { InstanceService } from '../services/InstanceService.js';
import { InstanceRoutes, dockerCaddy } from '../services/InstanceRoutes.js';
import { InstanceAddresses, adminEdge } from '../services/InstanceAddresses.js';
import { InstanceTrial } from '../services/InstanceTrial.js';
import { InstanceUpdates } from '../services/InstanceUpdates.js';
import { InstanceChart } from '../services/InstanceChart.js';
import { ReleaseCatalogue } from '../services/ReleaseCatalogue.js';
import { MoveExport } from '../services/MoveExport.js';
import { MoveRelay, kubeconfigFile } from '../services/MoveRelay.js';
import { PoolMonitoringService } from '../services/PoolMonitoringService.js';
import type { InstanceEdge, HeadscaleService, InfrastructureService } from '../../infrastructure/index.js';
import { identityRouter } from '../routes/identity.js';
import { handoffRouter } from '../routes/handoff.js';
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

  constructor(private readonly role: RoleConfig, private readonly env: NodeJS.ProcessEnv) {
    const name = env.INSTANCE_NAME;
    this.edge = role.instance && name && env.EDGE_ADMIN_URL && env.EDGE_CADDYFILE
      ? adminEdge(name, env.EDGE_ADMIN_URL, env.EDGE_CADDYFILE, () => this.addresses)
      : undefined;
  }

  follow(republish: () => Promise<void>): void {
    if (!this.edge || !this.role.instance) return;
    this.addresses = new InstanceAddresses(
      { rootUrl: this.role.instance.rootUrl, instanceId: this.role.instance.id, credential: this.env.INSTANCE_CREDENTIAL ?? '', name: this.edge.name },
      republish,
    );
    this.addresses.refresh().catch((err: Error) => console.warn(`[addresses] ${err.message}`));
  }

  current(): InstanceAddresses | undefined {
    return this.addresses;
  }
}

export interface MoveExportDeps {
  role: RoleConfig;
  env: NodeJS.ProcessEnv;
  app: Routes;
  dataDir: string;
  mongo: ReturnType<typeof mongoTarget>;
  running: () => Promise<string[] | 'unknown'>;
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
  auth: Pick<ReturnType<typeof createAuth>, 'requireAdmin' | 'userFromSessionCookie' | 'setSessionCookie'>;
  sessionKey: SecretKey;
  publicUrl: string;
  repoRoot: string;
  dataDir: string;
  headscale: HeadscaleService;
  infra: Pick<InfrastructureService, 'runKubectl' | 'applyManifest'>;
  side: InstanceSide;
  syncExposedApps: () => Promise<void>;
}

export interface InstancesWiring {
  instanceService: InstanceService | undefined;
}

export async function wireInstances(deps: InstancesWiringDeps): Promise<InstancesWiring> {
  const { role, env, app, tenant, db, identity, publicUrl } = deps;
  deps.side.follow(deps.syncExposedApps);

  if (holdsAccounts(role)) {
    app.use('/api/identity', identityRouter({ identity, servesTenants: servesTenants(role), signedIn: (req) => deps.auth.userFromSessionCookie(req.headers.cookie) }));
  }
  if (signsInThroughRoot(role.role)) app.use('/api/auth', handoffRouter({ identity, auth: deps.auth, sessionKey: deps.sessionKey }));

  tenant.use('/api/instance-addresses', instanceAddressesRouter({ addresses: () => deps.side.current() }));
  tenant.use('/api/instance-trial', instanceTrialRouter({
    trial: role.instance && env.INSTANCE_CREDENTIAL
      ? new InstanceTrial({ rootUrl: role.instance.rootUrl, instanceId: role.instance.id, credential: env.INSTANCE_CREDENTIAL })
      : undefined,
  }));

  tenant.use('/api/instance-updates', instanceUpdatesRouter({
    updates: role.instance && env.INSTANCE_CREDENTIAL
      ? new InstanceUpdates(
        { rootUrl: role.instance.rootUrl, instanceId: role.instance.id, credential: env.INSTANCE_CREDENTIAL, cronJob: env.SELF_UPGRADE_CRONJOB, namespace: env.INSTANCE_NAMESPACE },
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
  });
  releaseCatalogue.recordCurrent().catch((err: Error) => console.error(`[releases] could not record the release root runs: ${err.message}`));
  const routingDomain = env.INGRESS_DOMAIN || undefined;
  const instanceRoutes = routingDomain
    ? new InstanceRoutes(db.instances, routingDomain, path.join(deps.dataDir, 'caddy'), dockerCaddy(env.CADDY_CONTAINER || 'nowrinkles-caddy', env.CADDY_TLS_ADDRESS || '127.0.0.1:443'), (message) => console.error(message))
    : undefined;
  const siteNames = [env.APP_DOMAIN, env.MESH_DOMAIN]
    .filter((site): site is string => Boolean(site && routingDomain && site.endsWith(`.${routingDomain}`)))
    .map((site) => site.slice(0, -(routingDomain!.length + 1)));
  const poolTaskQueue = env.POOL_TASK_QUEUE || 'host-ops-queue';
  const pool = poolSettingsFrom(env, POOL_KUBECONFIG);
  const instanceService = new InstanceService(db, {
    rootUrl: publicUrl,
    rootPublicKeys: () => identity.publicKeys().map((key) => key.publicKey),
    meshLoginServer: env.MESH_LOGIN_SERVER,
    registry: env.INSTANCE_REGISTRY ?? '',
    imageTag: env.INSTANCE_IMAGE_TAG || 'dev',
    releases: releaseCatalogue,
    domain: routingDomain,
    siteNames,
    pool: 'off' in pool ? pool : { slots: pool.slots, trialDays: pool.trialDays },
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
  app.use('/api/instances', instancesRouter({ instances: instanceService, chart: () => instanceChart.path(), chartOf: (imageTag) => releaseCatalogue.chartFile(imageTag), mail: deps.mail, requireAdmin: deps.auth.requireAdmin, poolMonitoring, moveRelay, hubAccess }));
  const installer = (await fs.readFile(path.join(deps.repoRoot, 'scripts/instance/install.sh'), 'utf8')).replace('__ROOT_URL__', publicUrl);
  app.get('/install.sh', (_req, res) => res.type('text/x-shellscript').send(installer));
  app.get('/install/setup-gpu.sh', (_req, res) => res.type('text/x-shellscript').sendFile(path.join(deps.repoRoot, 'scripts/setup-gpu.sh')));
  return { instanceService };
}

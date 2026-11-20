import path from 'path';
import fs from 'fs/promises';
import type { Server as SocketServer } from 'socket.io';
import {
  type Database, type SecretKey, holdsAccounts, servesTenants, signsInThroughRoot, type RoleConfig, startedFor,
  getTemporalClient, type MailService, type createAuth, claimSettingsFrom, operatorsAmong, PLATFORM_OWNER, keepTrying,
  MailReputation, isOff, type BackendSettings, type Off, type DependencyStates,
} from '../../platform/index.js';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/common';
import type { InstanceRecord } from '../lib/instances.js';
import { issueMoveToken } from '../lib/identity-token.js';
import { HUB_AUDIENCE, hubInstancePart, type Mounts } from '../../hub/index.js';
import type { IdentityService } from '../services/IdentityService.js';
import { InstanceService, type SetupInstalls } from '../services/InstanceService.js';
import { InstanceReach } from '../services/InstanceReach.js';
import { InstanceRoutes, socketCaddy } from '../services/InstanceRoutes.js';
import { InstanceAddresses, adminEdge } from '../services/InstanceAddresses.js';
import { InstanceUpdates } from '../services/InstanceUpdates.js';
import { InstanceChart, releaseInventory } from '../services/InstanceChart.js';
import { chartDataVersion, ReleaseCatalogue } from '../services/ReleaseCatalogue.js';
import { DependencyWatch } from '../services/DependencyWatch.js';
import { DEPENDENCY_WATCH_ID } from '../lib/dependency-findings.js';
import { WithdrawalNotices } from '../services/WithdrawalNotices.js';
import { InstanceMailLimit } from '../services/InstanceMailLimit.js';
import { InstancePresence } from '../services/InstancePresence.js';
import { InstanceWatchSetting } from '../services/InstanceWatchSetting.js';
import { RootPresence } from '../services/RootPresence.js';
import { instanceWatchRouter } from '../routes/instance-watch.js';
import { PRESENCE_NAMESPACE, presenceAuth } from '../lib/instance-watch.js';
import type { EdgeSettings } from '../lib/edge-settings.js';
import type { ClusterAccess, InstanceEdge, HeadscaleService } from '../../infrastructure/index.js';
import { identityRouter } from '../routes/identity.js';
import { signInRouter } from '../routes/sign-in.js';
import { oidcProviderRouter } from '../routes/oidc-provider.js';
import type { RootProvider } from '../services/RootProvider.js';
import type { RootSignIn } from '../services/RootSignIn.js';
import { OIDC_PATH } from '../lib/oidc.js';
import { instancesRouter } from '../routes/instances.js';
import { instanceAddressesRouter } from '../routes/instance-addresses.js';
import { instanceUpdatesRouter } from '../routes/instance-updates.js';
import type { Routes } from '../../machines/index.js';
import { DependencyWatchWorkflow } from '../../workflows/DependencyWatchWorkflow.js';
import { QUEUES } from '../../platform/index.js';


export function edgeOf(edge: EdgeSettings | Off, addresses: () => InstanceAddresses | undefined): InstanceEdge | undefined {
  return isOff(edge) ? undefined : adminEdge(edge, addresses);
}

const selfUpgradeOf = (settings: BackendSettings): { cronJob?: string; namespace?: string } => {
  const upgrade = settings.instance?.selfUpgrade;
  return upgrade && !isOff(upgrade) ? upgrade : {};
};

export interface InstanceSidePlace {
  edge: EdgeSettings | Off;
  unreachableAfterMs: number;
}

export class InstanceSide {
  readonly edge: InstanceEdge | undefined;
  private addresses: InstanceAddresses | undefined;
  private rootPresence: RootPresence | undefined;
  private readonly heard: Record<string, () => void> = {};

  constructor(private readonly role: RoleConfig, private readonly place: InstanceSidePlace, private readonly rootToken: (() => Promise<string>) | undefined) {
    this.edge = role.instance ? edgeOf(place.edge, () => this.addresses) : undefined;
  }

  follow(republish: () => Promise<void>): void {
    if (!this.edge?.name || !this.role.instance || !this.rootToken) return;
    this.addresses = new InstanceAddresses(
      { rootUrl: this.role.instance.rootUrl, instanceId: this.role.instance.id, token: this.rootToken, name: this.edge.name },
      republish,
    );
    this.addresses.refresh().catch((err: Error) => console.warn(`[addresses] ${err.message}`));
  }

  current(): InstanceAddresses | undefined {
    return this.addresses;
  }

  hear(event: string, handler: () => void): void {
    this.heard[event] = handler;
  }

  watchRoot(tell: (ownerId: string, message: { title: string; body: string; path: string; tag: string }) => Promise<unknown>, dependencies: DependencyStates): void {
    if (!this.role.instance || !this.rootToken || this.rootPresence) return;
    const presence = new RootPresence({
      rootUrl: this.role.instance.rootUrl,
      instanceId: this.role.instance.id,
      ownerId: this.role.instance.ownerId,
      token: this.rootToken,
      tell,
      afterMs: this.place.unreachableAfterMs,
      heard: this.heard,
      dependency: dependencies,
    });
    this.rootPresence = presence;
    dependencies.toldByConnection('root');
    presence.start();
  }
}

export interface InstancesWiringDeps {
  role: RoleConfig;
  settings: BackendSettings;
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
  access: Pick<ClusterAccess, 'kubectl' | 'apply' | 'kubeconfigOf' | 'own' | 'packageChart'>;
  side: InstanceSide;
  syncExposedApps: () => Promise<void>;
  provider?: RootProvider | undefined;
  signIn?: RootSignIn | undefined;
  rootToken?: (() => Promise<string>) | undefined;
  io: SocketServer;
  instanceArrived?: ((instance: InstanceRecord) => void) | undefined;
  installs?: SetupInstalls | undefined;
}

export interface InstancesWiring {
  instanceService: InstanceService | undefined;
  tellInstance?: ((instanceId: string, event: string) => void) | undefined;
}

export async function wireInstances(deps: InstancesWiringDeps): Promise<InstancesWiring> {
  const { role, settings, app, tenant, db, identity, publicUrl } = deps;
  deps.side.follow(deps.syncExposedApps);

  app.use('/api/identity', identityRouter({
    servesTenants: servesTenants(role),
    accounts: holdsAccounts(role) ? {
      identity,
      signedIn: (req) => deps.auth.userFromSessionCookie(req.headers.cookie, deps.auth.securedFor(req)),
      reachOf: async (instanceId) => (await db.instances.getWatch(instanceId))?.reach,
    } : undefined,
  }));
  if (deps.provider) {
    const provider = deps.provider;
    app.use(OIDC_PATH, oidcProviderRouter({ provider, signedIn: (req) => deps.auth.userFromSessionCookie(req.headers.cookie, deps.auth.securedFor(req)) }));
    provider.keepDelivering();
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

  tenant.use('/api/instance-updates', instanceUpdatesRouter({
    updates: role.instance && deps.rootToken
      ? new InstanceUpdates(
        { rootUrl: role.instance.rootUrl, instanceId: role.instance.id, token: deps.rootToken, ...selfUpgradeOf(settings) },
        (args) => deps.access.kubectl(deps.access.own(), args),
      )
      : undefined,
  }));

  if (!holdsAccounts(role) || !settings.root) return { instanceService: undefined };
  const root = settings.root;

  const instanceChart = new InstanceChart(deps.repoRoot, deps.access);
  const releaseCatalogue = new ReleaseCatalogue(db.instances, {
    repoRoot: deps.repoRoot,
    chartsDir: path.join(deps.dataDir, 'instance-charts'),
    imageTag: root.imageTag,
    imageDigest: root.imageDigest,
    chart: () => instanceChart.path(),
    dataVersion: chartDataVersion(deps.repoRoot),
    inventory: (release, out) => releaseInventory(deps.repoRoot, release, out),
  });
  const withdrawalNotices = new WithdrawalNotices(db.instances, deps.mail, root.imageTag);
  releaseCatalogue.recordCurrent()
    .then(() => withdrawalNotices.tell())
    .catch((err: Error) => console.error(`[releases] could not record the release root runs: ${err.message}`));
  const routing = isOff(root.routing) ? undefined : root.routing;
  const routingDomain = routing?.domain;
  const instanceRoutes = routing
    ? new InstanceRoutes(db.instances, routing.domain, path.join(deps.dataDir, 'caddy'), socketCaddy(routing.caddy.adminSocket, routing.caddy.config, routing.caddy.log, routing.caddy.tlsAddress), (message) => console.error(message))
    : undefined;
  const siteNames = routing
    ? routing.siteDomains.filter((site) => site.endsWith(`.${routing.domain}`)).map((site) => site.slice(0, -(routing.domain.length + 1)))
    : [];
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
    currentRelease: root.imageTag,
    fetchImpl: fetch,
    sources: settings.tests.dependencySources,
    tell: async (message) => {
      for (const operator of operatorsAmong(await db.accounts.getUsers(), claimSettingsFrom(role))) {
        await deps.mail.toOwner(operator.id, message).catch((error: Error) => console.warn(`[dependencies] could not email ${operator.id} "${message.subject}": ${error.message}`));
      }
    },
    rootUrl: publicUrl,
  });
  void keepTrying('[dependencies] the daily check has not started yet', async () => {
    try {
      await (await getTemporalClient()).workflow.start(DependencyWatchWorkflow, {
        workflowId: DEPENDENCY_WATCH_ID,
        taskQueue: QUEUES.host,
        args: [],
        ...startedFor(PLATFORM_OWNER),
      });
    } catch (error) {
      if (error instanceof WorkflowExecutionAlreadyStartedError) return;
      const { message, cause } = error as Error & { cause?: unknown };
      throw new Error(cause instanceof Error ? `${message}: ${cause.message}` : message);
    }
  }, (message) => console.warn(message));
  let presenceOf: ((instanceId: string) => boolean) | undefined;
  const instanceService = new InstanceService(db, {
    connected: (instanceId) => presenceOf?.(instanceId) ?? false,
    serviceChanged: deps.instanceArrived,
    rootUrl: publicUrl,
    rootPublicKeys: () => identity.publicKeys().map((key) => key.publicKey),
    meshLoginServer: isOff(settings.mesh) ? undefined : settings.mesh.loginServer,
    registry: root.registry,
    imageTag: root.imageTag,
    releases: releaseCatalogue,
    notices: withdrawalNotices,
    domain: routingDomain,
    siteNames,
    serviceCaller: deps.provider ? (token) => deps.provider!.serviceCaller(token) : undefined,
    reach: new InstanceReach(settings.reach),
    installs: deps.installs,
  }, deps.headscale, () => new Date(), () => instanceRoutes?.changed());
  instanceRoutes?.start();
  let tellInstance: InstancesWiring['tellInstance'];
  if (role.role === 'root') {
    const presence = new InstancePresence({
      store: db.instances,
      tellOwner: (ownerId, message) => deps.mail.toOwner(ownerId, message),
      afterMs: settings.tests.unreachableAfterMs,
    });
    presenceOf = (instanceId) => presence.connected(instanceId);
    tellInstance = wireInstancePresence(deps.io, presence, (instanceId, token) => instanceService.caller(instanceId, token), deps.instanceArrived);
    presence.start().catch((err: Error) => console.warn(`[instance-presence] ${err.message}`));
  }

  const hubAccess = role.signing && role.hubLink
    ? async (instanceId: string, ownerId: string) => {
      const owner = await db.accounts.getUserById(ownerId);
      if (!owner) return undefined;
      return { token: issueMoveToken(role.signing!, HUB_AUDIENCE, hubInstancePart(instanceId, ownerId, owner.email)), hubUrl: role.hubLink!.url, personId: ownerId, email: owner.email, instanceId };
    }
    : undefined;
  const mailReputation = isOff(root.mailReputation) ? undefined : new MailReputation(root.mailReputation);
  if (mailReputation && role.role === 'root') void mailReputation.check().catch((err: Error) => console.warn(`[mail] the check of root's mail could not finish: ${err.message}`));
  app.use('/api/instances', instancesRouter({ instances: instanceService, mailLimit: new InstanceMailLimit(), chart: () => instanceChart.path(), chartOf: (imageTag) => releaseCatalogue.chartFile(imageTag), mail: deps.mail, operatorOnly: deps.auth.requireOperator('manage-accounts'), administers: deps.auth.requireOperator('administer'), dependencies: dependencyWatch, mailReputation, hubAccess }));
  return { instanceService, tellInstance };
}

export const instanceRoom = (instanceId: string): string => `instance:${instanceId}`;

export function wireInstancePresence(
  io: Pick<SocketServer, 'of'>,
  presence: Pick<InstancePresence, 'arrived' | 'left'>,
  caller: (instanceId: string, token: string) => Promise<InstanceRecord | undefined>,
  arrived: (instance: InstanceRecord) => void = () => undefined,
): (instanceId: string, event: string) => void {
  const namespace = io.of(PRESENCE_NAMESPACE);
  const admitted = new WeakMap<object, InstanceRecord>();
  namespace.use((socket, next) => {
    const auth = presenceAuth(socket.handshake.auth);
    if (!auth) return next(new Error('Unauthorized'));
    caller(auth.instanceId, auth.token).then((instance) => {
      if (!instance) return next(new Error('Unauthorized'));
      admitted.set(socket, instance);
      next();
    }, (err: Error) => {
      console.warn(`[instance-presence] ${auth.instanceId}'s connection could not be checked: ${err.message}`);
      next(new Error('root could not check this instance just now; it connects again by itself'));
    });
  });
  namespace.on('connection', (socket) => {
    const instance = admitted.get(socket);
    if (!instance) {
      socket.disconnect(true);
      return;
    }
    void presence.arrived(instance, socket.id);
    void socket.join(instanceRoom(instance.id));
    arrived(instance);
    socket.on('disconnect', () => { void presence.left(instance.id, socket.id); });
  });
  return (instanceId, event) => { namespace.to(instanceRoom(instanceId)).emit(event); };
}

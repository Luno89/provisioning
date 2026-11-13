import { roleRuns } from './work-places.js';
import type { TelemetryPlace } from './telemetry.js';
import { roleFromEnv, type RoleConfig } from './platform-role.js';
import { loadKey, loadKeys, type PlatformKeys } from './keys.js';
import { mongoTarget, type MongoTarget } from './mongo-target.js';
import { labFrom } from './lab.js';
import { cspModeFrom, type CspMode } from './csp.js';
import { trustProxyFor } from './client-address.js';
import { ourOrigins, type OurOrigins } from './same-site.js';
import { emailWayFrom, type EmailWay } from './email-way.js';
import { mailDomainFrom } from './mail-reputation.js';
import { podPlaceFrom, type PodPlace } from './drain.js';
import { settingHostPort, type Settings } from './setting-urls.js';
import { e2eProblem } from './auth.js';
import { minioSettingsFrom, type MinioSettings } from '../../files/lib/minio-settings.js';
import { giteaSettingsFrom, type GiteaSettings } from '../../projects/lib/gitea-settings.js';
import { infisicalSettingsFrom, type InfisicalSettings } from '../../infrastructure/lib/infisical-settings.js';
import { registrySettingsFrom } from '../../instances/lib/registry-settings.js';
import type { RegistryHosts } from '../../instances/index.js';
import { poolSettingsFrom, type PoolSettings } from '../../instances/lib/pool.js';
import { edgeSettingsFrom, type EdgeSettings } from '../../instances/lib/edge-settings.js';
import { reachSettingsFrom, type ReachSettings } from '../../instances/lib/instance-reach.js';
import { movedSettingsFrom, type MovedSettings } from '../../instances/lib/instance-move.js';
import { unreachableAfterMs } from '../../instances/lib/instance-watch.js';
import { signInProvidersFrom, signInReturnUrlFrom, type ConfiguredSignIn } from '../../accounts/lib/sign-in-providers.js';
import { hereFrom, serviceAccountFrom, type Here, type ServiceAccount } from '../../infrastructure/lib/cluster-places.js';
import { terraformStateFrom, type TerraformStateKind } from '../../infrastructure/lib/terraform-state.js';
import { DNS_PROVIDERS } from '../../infrastructure/lib/dns-providers.js';
import { scriptedModelBase } from '../../checks/lib/check-space.js';
import { OPENROUTER_URL } from '../../models/lib/openrouter-connect.js';
import { HUGGING_FACE } from '../../infrastructure/lib/model-download-job.js';
import { DEPENDENCY_SOURCES, dependencySourcesAt, type DependencySources } from './osv.js';

export type Env = Settings;

export type KoalaProcess = 'backend' | 'worker-host' | 'worker-cluster' | 'worker-engine';

export interface Off { readonly off: string }

export const isOff = (value: unknown): value is Off =>
  typeof value === 'object' && value !== null && typeof (value as { off?: unknown }).off === 'string';

export class SettingsError extends Error {
  constructor(readonly koalaProcess: string, readonly problems: readonly string[]) {
    super(`${koalaProcess} cannot start; its settings are not right:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
    this.name = 'SettingsError';
  }
}

const SERVICE_ACCOUNT_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';
export const MACHINE_GATEWAY_HOST = '0.0.0.0';

export interface TemporalSettings {
  address: string;
  namespace: string;
  caPath: string;
  production: boolean;
}

export interface ClusterSettings {
  here: Here;
  serviceAccount: ServiceAccount | undefined;
  rootKubeconfig: string | Off;
}

export interface TestParameters {
  unreachableAfterMs: number;
  openRouterUrl: string;
  huggingFaceUrl: string;
  dependencySources: DependencySources;
}

export interface ConnectionSettings {
  keys: PlatformKeys;
  mongo: MongoTarget;
  temporal: TemporalSettings;
}

export interface CommonSettings extends ConnectionSettings {
  koalaProcess: KoalaProcess;
  role: RoleConfig;
  dataDir: string;
  production: boolean;
  underTest: boolean;
  e2e: boolean;
  lab: boolean;
  telemetry: TelemetryPlace;
  clusters: ClusterSettings;
  tests: TestParameters;
}

export interface WebToolSettings {
  searxngUrl?: string | undefined;
  crawl4aiUrl?: string | undefined;
  crawl4aiToken?: string | undefined;
}

export interface MeshSettings {
  loginServer: string;
  headscaleUrl: string;
  headscaleApiKey?: string | undefined;
}

export interface CaddySettings {
  adminSocket: string;
  config: string;
  log: string;
  tlsAddress: string;
}

export interface RootRouting {
  domain: string;
  caddy: CaddySettings;
  siteDomains: string[];
}

export interface RootSettings {
  imageTag: string;
  imageDigest?: string | undefined;
  registry: string;
  routing: RootRouting | Off;
  pool: PoolSettings | Off;
  setupCode?: string | undefined;
  signIn: ConfiguredSignIn;
  signInReturn: { url?: string; problem?: string };
  mailReputation: { domain: string; relayhost?: string | undefined } | Off;
  hubLinked: boolean;
}

export interface InstanceSettings {
  credential: string;
  edge: EdgeSettings | Off;
  selfUpgrade: { cronJob: string; namespace: string } | Off;
  machineTemporalAddress: string | Off;
  gatewayPort: number;
  move: MovedSettings;
  poolMonitor: { rootUrl: string; instanceId: string } | Off;
}

export interface TenantServices {
  gitea: GiteaSettings;
  infisical: InfisicalSettings;
  minio: MinioSettings;
  registry: RegistryHosts;
  registryPullHost: string;
  webTools: WebToolSettings;
  checksApi: string;
}

export interface OperatorCredentials {
  env: Readonly<Record<string, string>>;
  ovhSubsidiary: string | Off;
  googleDrive: { clientId: string; clientSecret: string } | Off;
}

export interface BackendSettings extends CommonSettings {
  koalaProcess: 'backend';
  port: number;
  publicUrl: string;
  appUrl: string;
  origins: OurOrigins;
  csp: CspMode;
  trustProxy: number | 'loopback';
  metricsToken: string | Off;
  mail: EmailWay;
  pod: PodPlace | undefined;
  terraform: TerraformStateKind | Off;
  mesh: MeshSettings | Off;
  ingressDomain: string | Off;
  reach: ReachSettings;
  endpointRules: { scriptedBase?: string | undefined; lab: boolean };
  operator: OperatorCredentials;
  twilio: { accountSid: string; authToken: string; phoneNumber: string } | Off;
  tenant: TenantServices | undefined;
  instance: InstanceSettings | undefined;
  root: RootSettings | undefined;
  hubDatabase: string | undefined;
  hubGitea: GiteaSettings | undefined;
}

export interface WorkerHealth {
  healthPort: number;
  temporalMetricsPort: number;
}

export interface HostWorkerSettings extends CommonSettings, WorkerHealth {
  koalaProcess: 'worker-host';
  publicUrl: string | undefined;
  mail: EmailWay;
  mesh: MeshSettings | Off;
  operator: OperatorCredentials;
  webTools: WebToolSettings;
  root: { imageTag: string; ingressDomain: string | Off; pool: PoolSettings | Off } | undefined;
}

export interface ClusterWorkerSettings extends CommonSettings, WorkerHealth {
  koalaProcess: 'worker-cluster';
  gitea: GiteaSettings;
  registryPullHost: string;
  infisical: InfisicalSettings;
  terraform: TerraformStateKind;
  machineMetricsUrl: string | Off;
}

export interface EngineWorkerSettings extends CommonSettings, WorkerHealth {
  koalaProcess: 'worker-engine';
  publicUrl: string;
  instanceCredential: string;
  tenant: TenantServices;
  poolMonitor: { rootUrl: string; instanceId: string } | Off;
  mesh: MeshSettings | Off;
}

class Reading {
  readonly problems: string[] = [];

  constructor(readonly env: Env) {}

  take<T>(read: () => T): T | undefined {
    try {
      return read();
    } catch (err) {
      this.problems.push((err as Error).message);
      return undefined;
    }
  }
}

const settingIn = (env: Env, name: string): string | undefined => env[name]?.trim() || undefined;

function required(read: Reading, name: string, why: string): string | undefined {
  const value = settingIn(read.env, name);
  if (value === undefined) read.problems.push(`${name} is not set: ${why}`);
  return value;
}

function folderSetting(read: Reading, name: string, why: string): string | undefined {
  const value = required(read, name, why);
  if (value === undefined) return undefined;
  if (value.startsWith('/')) return value.replace(/(.)\/+$/, '$1');
  read.problems.push(`${name} is not an absolute path: ${value}`);
  return undefined;
}

function dependencySourcesFrom(read: Reading): DependencySources {
  const base = settingIn(read.env, 'DEPENDENCY_SOURCES');
  if (base === undefined) return DEPENDENCY_SOURCES;
  return read.take(() => dependencySourcesAt(wholeUrl('DEPENDENCY_SOURCES', base))) ?? DEPENDENCY_SOURCES;
}

const dataDirFrom = (read: Reading): string | undefined => folderSetting(read, 'DATA_DIR', 'it is the folder this process keeps its files in');

function urlSetting(read: Reading, name: string, why: string): string | undefined {
  const value = required(read, name, why);
  return value === undefined ? undefined : read.take(() => wholeUrl(name, value));
}

function hostPortSetting(read: Reading, name: string, why: string): string | undefined {
  const value = required(read, name, why);
  return value === undefined ? undefined : read.take(() => settingHostPort(name, value));
}

function portSetting(read: Reading, name: string, why: string, zeroAllowed = false): number | undefined {
  const value = required(read, name, why);
  if (value === undefined) return undefined;
  const port = Number(value);
  if (Number.isInteger(port) && port < 65536 && (port > 0 || (zeroAllowed && port === 0))) return port;
  read.problems.push(`${name} is not a port: ${value}`);
  return undefined;
}

function wholeUrl(name: string, raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} is not an address: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`${name} is not an http or https address: ${raw}`);
  return raw.replace(/\/+$/, '');
}

const OPERATOR_CREDENTIAL_NAMES = [
  'OVH_APPLICATION_KEY', 'OVH_APPLICATION_SECRET', 'OVH_CONSUMER_KEY', 'OVH_SUBSIDIARY',
  ...DNS_PROVIDERS.flatMap((provider) => provider.credential.flatMap((field) => [field.env, ...(field.aliases ?? [])])),
];

function operatorCredentials(read: Reading): OperatorCredentials {
  const env = Object.fromEntries(OPERATOR_CREDENTIAL_NAMES.flatMap((name) => {
    const value = settingIn(read.env, name);
    return value === undefined ? [] : [[name, value]];
  })) as Record<string, string>;
  const ovhKeys = ['OVH_APPLICATION_KEY', 'OVH_APPLICATION_SECRET', 'OVH_CONSUMER_KEY'].filter((name) => env[name]);
  if (ovhKeys.length > 0 && !env.OVH_SUBSIDIARY) read.problems.push('OVH_SUBSIDIARY is not set beside the operator\'s OVHcloud keys: it names the OVHcloud account\'s subsidiary (FR, AU, CA, …)');
  const subsidiary = env.OVH_SUBSIDIARY;
  const googleId = settingIn(read.env, 'GOOGLE_CLIENT_ID');
  const googleSecret = settingIn(read.env, 'GOOGLE_CLIENT_SECRET');
  if (Boolean(googleId) !== Boolean(googleSecret)) read.problems.push('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET go together, and only one is set');
  return {
    env,
    ovhSubsidiary: subsidiary ?? { off: 'OVH_SUBSIDIARY is not set, so OVHcloud\'s prices are not read' },
    googleDrive: googleId && googleSecret
      ? { clientId: googleId, clientSecret: googleSecret }
      : { off: 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set, so backups to Google Drive are off' },
  };
}

function meshFrom(read: Reading): MeshSettings | Off {
  const loginServer = settingIn(read.env, 'MESH_LOGIN_SERVER');
  if (!loginServer) return { off: 'MESH_LOGIN_SERVER is not set, so machines and instances join no mesh' };
  const headscaleUrl = urlSetting(read, 'HEADSCALE_URL', 'with MESH_LOGIN_SERVER set, root runs the mesh through Headscale at this address');
  return { loginServer, headscaleUrl: headscaleUrl ?? '', ...(settingIn(read.env, 'HEADSCALE_API_KEY') ? { headscaleApiKey: settingIn(read.env, 'HEADSCALE_API_KEY') } : {}) };
}

const NO_MESH_HERE = (role: string): Off => ({ off: `${role} runs no mesh; root does` });

function webToolsFrom(read: Reading): WebToolSettings {
  return {
    searxngUrl: urlSetting(read, 'SEARXNG_URL', 'it is where web search is asked; the instance chart sets it'),
    crawl4aiUrl: urlSetting(read, 'CRAWL4AI_URL', 'it is where pages are read and crawled; the instance chart sets it'),
    crawl4aiToken: required(read, 'CRAWL4AI_API_TOKEN', 'Crawl4AI reads pages only for a caller holding its token; the instance chart makes it'),
  };
}

function common(read: Reading, koalaProcess: KoalaProcess, role: RoleConfig | undefined): CommonSettings | undefined {
  const { env } = read;
  const production = env.NODE_ENV === 'production';
  const keys = read.take(() => loadKeys(env));
  const mongo = read.take(() => mongoTarget(env));
  const address = hostPortSetting(read, 'TEMPORAL_CONNECTION_ADDRESS', 'it is where Temporal answers this process');
  const namespace = required(read, 'TEMPORAL_NAMESPACE', 'it is the Temporal namespace this install works in');
  const caPath = required(read, 'TEMPORAL_TLS_CA', 'it is the file holding the certificate authority Temporal\'s certificate is signed by');
  const dataDir = dataDirFrom(read);
  const pool = env.POOL?.trim();
  if (pool !== undefined && pool !== '' && pool !== 'true') read.problems.push(`POOL is "${pool}"; it is "true" on a trial instance on Koala's servers and unset anywhere else`);
  const here = hereFrom(env, role?.role === 'root');
  if (role?.role === 'instance' && pool === 'true' && !here.poolName) read.problems.push('INSTANCE_NAME is not set: a trial instance on Koala\'s servers is named by it');
  const rootKubeconfig = role?.role === 'root' ? settingIn(read.env, 'POOL_KUBECONFIG') : undefined;
  if (!role || !keys || !mongo || !address || !namespace || !caPath || !dataDir) return undefined;
  return {
    koalaProcess,
    role,
    dataDir,
    production,
    underTest: env.NODE_ENV === 'test',
    e2e: env.IS_E2E === 'true',
    lab: labFrom(env),
    keys,
    mongo,
    temporal: { address, namespace, caPath, production },
    telemetry: {
      version: settingIn(read.env, 'KOALA_VERSION'),
      instanceId: settingIn(read.env, 'INSTANCE_ID'),
      cluster: settingIn(read.env, 'KOALA_TELEMETRY_CLUSTER'),
      otlpEndpoint: settingIn(read.env, 'OTEL_EXPORTER_OTLP_ENDPOINT'),
    },
    clusters: {
      here,
      serviceAccount: serviceAccountFrom(env, SERVICE_ACCOUNT_DIR),
      rootKubeconfig: rootKubeconfig ?? { off: role.role === 'root' ? 'POOL_KUBECONFIG is not set, so root reaches no cluster of its own' : 'only root reaches root\'s own cluster' },
    },
    tests: {
      unreachableAfterMs: read.take(() => unreachableAfterMs(env)) ?? 0,
      openRouterUrl: settingIn(read.env, 'OPENROUTER_URL') ?? OPENROUTER_URL,
      huggingFaceUrl: settingIn(read.env, 'HUGGING_FACE_URL') ?? HUGGING_FACE,
      dependencySources: dependencySourcesFrom(read),
    },
  };
}

function tenantServices(read: Reading): TenantServices | undefined {
  const gitea = read.take(() => giteaSettingsFrom(read.env));
  const infisical = read.take(() => infisicalSettingsFrom(read.env));
  const minio = read.take(() => minioSettingsFrom(read.env));
  const registry = read.take(() => registrySettingsFrom(read.env));
  const registryPullHost = hostPortSetting(read, 'REGISTRY_PULL_HOST', 'it is where the cluster pulls the images Koala builds; the instance chart sets it');
  const webTools = webToolsFrom(read);
  const checksApi = urlSetting(read, 'CHECKS_API_URL', 'it is where the check runner and the scripted model reach this instance\'s API; the instance chart sets it');
  if (!gitea || !infisical || !minio || !registry || !registryPullHost || !checksApi) return undefined;
  return { gitea, infisical, minio, registry, registryPullHost, webTools, checksApi };
}

function terraformFrom(read: Reading): TerraformStateKind | undefined {
  return read.take(() => terraformStateFrom(read.env));
}

function finish<T>(read: Reading, koalaProcess: string, settings: T | undefined = undefined): T {
  if (read.problems.length > 0 || settings === undefined) throw new SettingsError(koalaProcess, read.problems.length > 0 ? read.problems : ['its settings could not be read']);
  return settings;
}

function rootSettings(read: Reading, role: RoleConfig): RootSettings | undefined {
  const { env } = read;
  const imageTag = required(read, 'INSTANCE_IMAGE_TAG', 'it is the release root runs, which it serves to instances');
  const registry = hostPortSetting(read, 'INSTANCE_REGISTRY', 'it is root\'s registry, which machines and instances pull Koala\'s image from');
  const domain = settingIn(read.env, 'INGRESS_DOMAIN');
  let routing: RootRouting | Off = { off: 'INGRESS_DOMAIN is not set, so instances get no addresses of their own' };
  if (domain) {
    const why = 'with INGRESS_DOMAIN set, root routes instances through its Caddy, which it reloads with this';
    const adminSocket = required(read, 'CADDY_ADMIN_SOCKET', why);
    const config = required(read, 'CADDY_CONFIG', why);
    const log = required(read, 'CADDY_LOG', why);
    const tlsAddress = hostPortSetting(read, 'CADDY_TLS_ADDRESS', why);
    const siteDomains = [settingIn(read.env, 'APP_DOMAIN'), settingIn(read.env, 'MESH_DOMAIN')].filter((site): site is string => Boolean(site));
    if (adminSocket && config && log && tlsAddress) routing = { domain, caddy: { adminSocket, config, log, tlsAddress }, siteDomains };
  }
  const pool = read.take(() => poolSettingsFrom(env));
  const mailDomain = mailDomainFrom(env);
  const smtp = Boolean(settingIn(read.env, 'MAIL_SMTP_URL'));
  const relayhost = settingIn(read.env, 'MAIL_RELAYHOST');
  const setupCode = settingIn(read.env, 'ADMIN_SETUP_CODE');
  if (!imageTag || !registry || !pool) return undefined;
  return {
    imageTag,
    imageDigest: settingIn(read.env, 'INSTANCE_IMAGE_DIGEST'),
    registry,
    routing,
    pool,
    ...(setupCode ? { setupCode } : {}),
    signIn: signInProvidersFrom(env),
    signInReturn: signInReturnUrlFrom(env),
    mailReputation: mailDomain && smtp
      ? { domain: mailDomain, ...(relayhost ? { relayhost } : {}) }
      : { off: 'root sends no mail of its own (MAIL_SMTP_URL, and DOMAIN or MAIL_FROM), so there is no mail to check' },
    hubLinked: Boolean(role.hubLink),
  };
}

function instanceSettings(read: Reading, role: RoleConfig): InstanceSettings | undefined {
  const { env } = read;
  const credential = required(read, 'INSTANCE_CREDENTIAL', 'it is this instance\'s credential at root, without which nobody signs in to it; the instance chart sets it');
  const edge = read.take(() => edgeSettingsFrom(env));
  const cronJob = settingIn(read.env, 'SELF_UPGRADE_CRONJOB');
  const namespace = settingIn(read.env, 'INSTANCE_NAMESPACE');
  if (Boolean(cronJob) !== Boolean(namespace)) read.problems.push('SELF_UPGRADE_CRONJOB and INSTANCE_NAMESPACE go together, and only one is set');
  const machineTemporal = settingIn(read.env, 'MACHINE_TEMPORAL_ADDRESS');
  const gatewayPort = portSetting(read, 'MACHINE_GATEWAY_PORT', 'it is the port the machine gateway listens on (0 for any free port)', true);
  const pool = env.POOL?.trim() === 'true';
  if (!credential || !edge || gatewayPort === undefined) return undefined;
  return {
    credential,
    edge,
    selfUpgrade: cronJob && namespace ? { cronJob, namespace } : { off: 'SELF_UPGRADE_CRONJOB is not set, so this instance is updated only by its installer' },
    machineTemporalAddress: machineTemporal
      ? (read.take(() => settingHostPort('MACHINE_TEMPORAL_ADDRESS', machineTemporal)) ?? machineTemporal)
      : { off: 'MACHINE_TEMPORAL_ADDRESS is not set (the instance chart sets it from mesh.address), so no machine can take this instance\'s work' },
    gatewayPort,
    move: movedSettingsFrom(env),
    poolMonitor: pool && role.instance
      ? { rootUrl: role.instance.rootUrl, instanceId: role.instance.id }
      : { off: 'this instance is not on Koala\'s servers, so it monitors its own apps' },
  };
}

export function backendSettingsFrom(env: Env): BackendSettings {
  const read = new Reading(env);
  const role = read.take(() => roleFromEnv(env));
  const base = common(read, 'backend', role);
  const port = portSetting(read, 'PORT', 'it is the port the backend listens on (0 for any free port)', true);
  const publicUrl = urlSetting(read, 'PUBLIC_URL', 'it is the address people and other Koalas reach this backend at');
  const appUrl = urlSetting(read, 'APP_URL', 'it is the address the browser loads Koala\'s pages from (PUBLIC_URL where the backend serves them)');
  const e2e = e2eProblem(env);
  if (e2e) read.problems.push(e2e);
  const terraform = role?.role === 'hub' ? { off: 'the hub runs no Terraform' } : terraformFrom(read);
  const tenant = role?.role === 'instance' ? tenantServices(read) : undefined;
  const instance = role?.role === 'instance' ? instanceSettings(read, role) : undefined;
  const root = role?.role === 'root' ? rootSettings(read, role) : undefined;
  const hubDatabase = role?.role === 'hub' ? required(read, 'HUB_DATABASE', 'it is the database the hub keeps its registry of shared projects in') : undefined;
  const hubGitea = role?.role === 'hub' ? read.take(() => giteaSettingsFrom(env)) : undefined;
  const mail = role ? read.take(() => emailWayFrom(env, role)) : undefined;
  const mesh = role?.role === 'root' ? meshFrom(read) : NO_MESH_HERE(role?.role ?? 'this process');
  const ingressDomain = settingIn(read.env, 'INGRESS_DOMAIN');
  const metricsToken = settingIn(read.env, 'METRICS_TOKEN');
  const twilio = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER'].map((name) => settingIn(read.env, name));
  if (twilio.some(Boolean) && !twilio.every(Boolean)) read.problems.push('TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_PHONE_NUMBER go together, and only some are set');
  const operator = operatorCredentials(read);
  const scriptedBase = tenant ? scriptedModelBase(tenant.checksApi) : undefined;
  if (!base || port === undefined || !publicUrl || !appUrl || !mail || terraform === undefined
    || (role?.role === 'instance' && (!tenant || !instance))
    || (role?.role === 'root' && !root)
    || (role?.role === 'hub' && (!hubDatabase || !hubGitea))) return finish<BackendSettings>(read, 'the backend');
  return finish(read, 'the backend', {
    ...base,
    koalaProcess: 'backend',
    port,
    publicUrl,
    appUrl,
    origins: ourOrigins({ PUBLIC_URL: publicUrl, APP_URL: appUrl, NODE_ENV: env.NODE_ENV }),
    csp: cspModeFrom(env),
    trustProxy: trustProxyFor(env),
    metricsToken: metricsToken ?? { off: 'METRICS_TOKEN is not set, so /api/metrics serves nothing' },
    mail,
    pod: podPlaceFrom(env),
    terraform,
    mesh,
    ingressDomain: ingressDomain ?? { off: 'INGRESS_DOMAIN is not set, so this Koala gives nothing an address of its own on the open internet' },
    reach: reachSettingsFrom({ NODE_ENV: env.NODE_ENV, INGRESS_DOMAIN: ingressDomain, CADDY_TLS_ADDRESS: root && !isOff(root.routing) ? root.routing.caddy.tlsAddress : undefined }, base.lab),
    endpointRules: { ...(scriptedBase ? { scriptedBase } : {}), lab: base.lab },
    operator,
    twilio: twilio.every(Boolean)
      ? { accountSid: twilio[0]!, authToken: twilio[1]!, phoneNumber: twilio[2]! }
      : { off: 'sign-in codes by SMS need Twilio, which this server does not have set up' },
    tenant,
    instance,
    root,
    hubDatabase,
    hubGitea,
  });
}

function workerHealth(read: Reading, metricsName: string): WorkerHealth | undefined {
  const healthPort = portSetting(read, 'HEALTH_PORT', 'it is the port this worker answers /healthz on (0 for none)', true);
  const temporalMetricsPort = portSetting(read, metricsName, 'it is the port Temporal\'s runtime serves this worker\'s metrics on (0 for any free port)', true);
  return healthPort === undefined || temporalMetricsPort === undefined ? undefined : { healthPort, temporalMetricsPort };
}

export function hostWorkerSettingsFrom(env: Env): HostWorkerSettings {
  const read = new Reading(env);
  const role = read.take(() => roleFromEnv(env));
  const base = common(read, 'worker-host', role);
  if (role && !roleRuns(role.role, 'host')) read.problems.push(`the host worker runs only on root and in an instance, and ROLE is ${role.role}`);
  const health = workerHealth(read, 'TEMPORAL_METRICS_PORT');
  const onRoot = role?.role === 'root';
  const publicUrl = onRoot ? urlSetting(read, 'PUBLIC_URL', 'it is root\'s own address, which its pool and dependency watch hand on') : undefined;
  const imageTag = onRoot ? required(read, 'INSTANCE_IMAGE_TAG', 'it is the release root runs') : undefined;
  const pool = onRoot ? read.take(() => poolSettingsFrom(env)) : undefined;
  const ingressDomain = settingIn(read.env, 'INGRESS_DOMAIN');
  const mail = role ? read.take(() => emailWayFrom(env, role)) : undefined;
  const mesh = onRoot ? meshFrom(read) : NO_MESH_HERE(role?.role ?? 'this process');
  const operator = operatorCredentials(read);
  const webTools = role?.role === 'instance' ? webToolsFrom(read) : {};
  if (!base || !health || !mail || (onRoot && (!publicUrl || !imageTag || !pool))) return finish<HostWorkerSettings>(read, 'the host worker');
  return finish(read, 'the host worker', {
    ...base,
    ...health,
    koalaProcess: 'worker-host',
    publicUrl,
    mail,
    mesh,
    operator,
    webTools,
    root: onRoot ? { imageTag: imageTag!, ingressDomain: ingressDomain ?? { off: 'INGRESS_DOMAIN is not set' }, pool: pool! } : undefined,
  });
}

export function clusterWorkerSettingsFrom(env: Env): ClusterWorkerSettings {
  const read = new Reading(env);
  const role = read.take(() => roleFromEnv(env));
  const base = common(read, 'worker-cluster', role);
  if (role && !roleRuns(role.role, 'cluster')) read.problems.push(`the cluster worker runs only in an instance, whose apps it deploys, and ROLE is ${role.role}`);
  const health = workerHealth(read, 'TEMPORAL_METRICS_PORT');
  const gitea = read.take(() => giteaSettingsFrom(env));
  const infisical = read.take(() => infisicalSettingsFrom(env));
  const terraform = terraformFrom(read);
  const registryPullHost = hostPortSetting(read, 'REGISTRY_PULL_HOST', 'it is where the cluster pulls the images Koala builds; the instance chart sets it');
  const metricsUrl = settingIn(read.env, 'MACHINE_METRICS_URL');
  if (!base || !health || !gitea || !infisical || !terraform || !registryPullHost) return finish<ClusterWorkerSettings>(read, 'the cluster worker');
  return finish(read, 'the cluster worker', {
    ...base,
    ...health,
    koalaProcess: 'worker-cluster',
    gitea,
    registryPullHost,
    infisical,
    terraform,
    machineMetricsUrl: metricsUrl
      ? (read.take(() => wholeUrl('MACHINE_METRICS_URL', metricsUrl)) ?? metricsUrl)
      : { off: 'MACHINE_METRICS_URL is not set (the instance chart sets it from mesh.address and backend.nodePort), so an app on another machine gets no monitoring and is not deployed' },
  });
}

export function engineWorkerSettingsFrom(env: Env): EngineWorkerSettings {
  const read = new Reading(env);
  const role = read.take(() => roleFromEnv(env));
  const base = common(read, 'worker-engine', role);
  const health = workerHealth(read, 'TEMPORAL_ENGINE_METRICS_PORT');
  const publicUrl = urlSetting(read, 'PUBLIC_URL', 'it is the instance\'s own address, which its sign-in through root names');
  const instanceCredential = required(read, 'INSTANCE_CREDENTIAL', 'it is the instance\'s credential at root, which its runs reach root with');
  const tenant = tenantServices(read);
  if (role && !roleRuns(role.role, 'engine')) read.problems.push(`the engine worker runs only in an instance, and ROLE is ${role.role}`);
  if (!base || !health || !publicUrl || !instanceCredential || !tenant) return finish<EngineWorkerSettings>(read, 'the engine worker');
  return finish(read, 'the engine worker', {
    ...base,
    ...health,
    koalaProcess: 'worker-engine',
    publicUrl,
    instanceCredential,
    tenant,
    poolMonitor: env.POOL?.trim() === 'true' && base.role.instance
      ? { rootUrl: base.role.instance.rootUrl, instanceId: base.role.instance.id }
      : { off: 'this instance is not on Koala\'s servers, so it monitors its own apps' },
    mesh: NO_MESH_HERE('an instance'),
  });
}

export interface PodStepSettings {
  role: RoleConfig;
  clusters: ClusterSettings;
}

function podStep(read: Reading): PodStepSettings | undefined {
  const role = read.take(() => roleFromEnv(read.env));
  if (role && role.role !== 'instance') read.problems.push(`this step runs only in an instance's pod, and ROLE is ${role.role}`);
  const here = hereFrom(read.env, false);
  if (!here.koalaMachineId && !here.poolName) read.problems.push('neither INSTANCE_MACHINE_ID nor POOL with INSTANCE_NAME is set, so this step does not know the cluster it runs in');
  return role ? { role, clusters: { here, serviceAccount: serviceAccountFrom(read.env, SERVICE_ACCOUNT_DIR), rootKubeconfig: { off: 'only root reaches root\'s own cluster' } } } : undefined;
}

export function podStepSettingsFrom(env: Env): PodStepSettings {
  const read = new Reading(env);
  return finish(read, 'this step', podStep(read));
}

export interface SelfUpgradeSettings extends PodStepSettings {
  root: { url: string; instanceId: string; credential: string };
  release: { name: string; namespace: string; current: string };
}

export function selfUpgradeSettingsFrom(env: Env): SelfUpgradeSettings {
  const read = new Reading(env);
  const step = podStep(read);
  const credential = required(read, 'INSTANCE_CREDENTIAL', 'it is the credential this instance asks root for its release with');
  const why = 'the self-upgrade CronJob names the release it upgrades';
  const name = required(read, 'RELEASE_NAME', why);
  const namespace = required(read, 'RELEASE_NAMESPACE', why);
  const current = required(read, 'CURRENT_IMAGE_TAG', why);
  const instance = step?.role.instance;
  return finish(read, 'the self-upgrade', step && instance && credential && name && namespace && current
    ? { ...step, root: { url: instance.rootUrl, instanceId: instance.id, credential }, release: { name, namespace, current } }
    : undefined);
}

export interface MoveImportSettings extends PodStepSettings {
  rootUrl: string;
  instanceId: string;
  credential: string;
  mongo: MongoTarget;
  dataKey: PlatformKeys['data'];
  gitea: GiteaSettings;
  registryPullHost: string;
  terraform: TerraformStateKind;
  podNamespace: string;
  dataDir: string;
}

export function moveImportSettingsFrom(env: Env): MoveImportSettings {
  const read = new Reading(env);
  const step = podStep(read);
  const credential = required(read, 'INSTANCE_CREDENTIAL', 'it is the credential this instance fetches its moved parts from root with');
  const mongo = read.take(() => mongoTarget(env));
  const dataKey = read.take(() => loadKey(env, 'data'));
  const gitea = read.take(() => giteaSettingsFrom(env));
  const registryPullHost = hostPortSetting(read, 'REGISTRY_PULL_HOST', 'it is where the cluster pulls the images Koala builds; the instance chart sets it');
  const terraform = terraformFrom(read);
  const podNamespace = required(read, 'POD_NAMESPACE', 'it is this instance\'s own namespace, where Terraform keeps its state');
  const dataDir = dataDirFrom(read);
  const instance = step?.role.instance;
  return finish(read, 'the move', step && instance && credential && mongo && dataKey && gitea && registryPullHost && terraform && podNamespace && dataDir
    ? { ...step, rootUrl: instance.rootUrl, instanceId: instance.id, credential, mongo, dataKey, gitea, registryPullHost, terraform, podNamespace, dataDir }
    : undefined);
}

export function operatorCredentialsFrom(env: Env): OperatorCredentials {
  const read = new Reading(env);
  return finish(read, 'this program', operatorCredentials(read));
}

export function clusterSettingsFrom(env: Env): PodStepSettings {
  const read = new Reading(env);
  const role = read.take(() => roleFromEnv(env));
  const root = role?.role === 'root';
  const rootKubeconfig = root ? settingIn(read.env, 'POOL_KUBECONFIG') : undefined;
  return finish(read, 'this program', role
    ? { role, clusters: { here: hereFrom(env, root), serviceAccount: serviceAccountFrom(env, SERVICE_ACCOUNT_DIR), rootKubeconfig: rootKubeconfig ?? { off: root ? 'POOL_KUBECONFIG is not set, so root reaches no cluster of its own' : 'only root reaches root\'s own cluster' } } }
    : undefined);
}

export function connectionSettingsFrom(env: Env): ConnectionSettings {
  const read = new Reading(env);
  const keys = read.take(() => loadKeys(env));
  const mongo = read.take(() => mongoTarget(env));
  const address = hostPortSetting(read, 'TEMPORAL_CONNECTION_ADDRESS', 'it is where Temporal answers');
  const namespace = required(read, 'TEMPORAL_NAMESPACE', 'it is the Temporal namespace this install works in');
  const caPath = required(read, 'TEMPORAL_TLS_CA', 'it is the file holding Temporal\'s certificate authority');
  return finish(read, 'this program', keys && mongo && address && namespace && caPath
    ? { keys, mongo, temporal: { address, namespace, caPath, production: env.NODE_ENV === 'production' } }
    : undefined);
}

export function databaseSettingsFrom(env: Env): { mongo: MongoTarget; dataKey: PlatformKeys['data'] } {
  const read = new Reading(env);
  const dataKey = read.take(() => loadKey(env, 'data'));
  const mongo = read.take(() => mongoTarget(env));
  return finish(read, 'this program', dataKey && mongo ? { mongo, dataKey } : undefined);
}

export const settingProblem = (err: unknown): string | undefined => (err instanceof SettingsError ? err.message : undefined);

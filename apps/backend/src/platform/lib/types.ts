import type { Router } from 'express';
import type { GpuWithoutDriver, MachineGpu } from '@koala/engine-core';
import { DNS_PROVIDER_NAMES, type DnsProviderName } from '../../infrastructure/lib/dns-providers.js';
import type { AgentUpdateReport, MachineAgent, ManualMachineAgent } from '../../machines/index.js';
export type Mounts = { use(path: string, router: Router): unknown };
export type PartialInfo<T> = { [K in keyof T]?: T[K] | undefined };

export type ClusterProviderName = 'machine' | 'pool' | 'root';

export interface ClusterMetadata {
  id: string;
  name: string;
  provider: ClusterProviderName;
  status: 'provisioning' | 'healthy' | 'failed' | 'destroying' | 'discovered' | 'destroyed' | 'stopped';
  lastLogPath?: string;
  temporalWorkflowId?: string;
  createdAt?: string;
  lastSyncedAt?: string;
  capacity?: {
    cpuCores: number;
    ramGb: number;
    gpuCount?: number;
    gpuVendor?: 'nvidia' | 'amd';
  };
  ownerId?: string;
  machineId?: string;
  kubeconfigEnc?: string;
  metricsTokenHash?: string;
  meshIp?: string;
  gpus?: MachineGpu[];
  gpuProblems?: string[];
  gpusWithoutDriver?: GpuWithoutDriver[];
  [key: string]: unknown;
}

export interface RequestedAppSettings {
  vllmModel?: string;
  vllmGpuCount?: number;
  vllmGpuVendor?: 'nvidia' | 'amd';
  vllmCachePvc?: string;
  vllmHfToken?: string;
  vllmMaxModelLen?: number;
  vllmGpuMemUtil?: number;
  vllmExtraArgs?: string;
  vllmToolCallingEnabled?: boolean;
  vllmToolCallParser?: string;
  vllmServedModelName?: string;
  vllmMaxNumSeqs?: number;
  vllmDtype?: 'auto' | 'half' | 'float16' | 'bfloat16' | 'float' | 'float32';
  vllmEnablePrefixCaching?: boolean;
  tabbyModel?: string;
  tabbyRevision?: string;
  tabbyGpuCount?: number;
  tabbyHfToken?: string;
  tabbyCachePvc?: string;
  tabbyImageTag?: string;
  tabbyCacheMode?: 'FP16' | 'Q8' | 'Q6' | 'Q4';
  tabbyMaxSeqLen?: number;
  tabbyMaxBatchSize?: number;
  tabbyReasoning?: boolean;
  tabbyToolFormat?: 'mistral' | 'mistral_old' | 'qwen3_coder' | 'gemma4' | 'glm4_5' | 'minimax_m2' | 'harmony';
  tabbyInlineModelLoading?: boolean;
  tabbyDisableAuth?: boolean;
  tabbyMemoryLimit?: string;
  tabbyShmSize?: string;
  tabbyCpuLimit?: string;
  tabbyExtraEnv?: string;
  searxngSecretKey?: string;
  searxngEngines?: string;
  crawl4aiApiToken?: string;
  crawl4aiMemoryLimit?: string;
  crawl4aiShmSize?: string;
  gitappEnv?: string;
  webuiEnableWebSearch?: boolean;
  webuiWebSearchEngine?: 'duckduckgo' | 'tavily' | 'brave' | 'serper' | 'bing';
  webuiWebSearchApiKey?: string;
  appSettings?: Record<string, string>;
}

export interface AppSettings extends RequestedAppSettings {
  minioRootUser?: string;
  minioRootPassword?: string;
  minioStorage?: string;
  nextcloudAdminPassword?: string;
  nextcloudDbPassword?: string;
  nextcloudDbRootPassword?: string;
  hermesDashboardPassword?: string;
  qdrantApiKey?: string;
  qdrantStorage?: string;
  qdrantMemoryLimit?: string;
  quickwitS3Endpoint?: string;
  quickwitS3AccessKey?: string;
  quickwitS3SecretKey?: string;
  quickwitBucket?: string;
  teiModelId?: string;
  teiUseGpu?: boolean;
  teiMemoryLimit?: string;
  verdaccioUpstream?: string;
  verdaccioStorage?: string;
}

export interface DeploymentMetadata extends AppSettings {
  id: string;
  failure?: string | undefined;
  name: string;
  deploymentId?: string;
  clusterId: string;
  ownerId?: string;
  strategy: 'helm' | 'native';
  appType?: string;
  gitappProjectId?: string;
  gitappImageTag?: string;
  namespace?: string;
  status: 'deploying' | 'running' | 'failed' | 'unhealthy' | 'destroying' | 'discovered';
  healthReason?: string;
  deployNotes?: string[];
  webRepo?: string;
  webTag?: string;
  dbRepo?: string;
  dbTag?: string;
  url?: string;
  isExposed?: boolean;
  exposureUrl?: string;
  exposurePath?: string;
  isExposedLocally?: boolean;
  localExposureUrl?: string;
  isExposedPublicly?: boolean;
  publicExposureUrl?: string;
  previewLocalUrl?: string;
  previewPublicUrl?: string;
  publicHostname?: string;
  lastLogPath?: string;
  modules?: string[];
  storage?: Record<string, string>;
  vpnEnabled?: boolean;
  vpnProtocol?: 'wireguard' | 'openvpn';
  vpnConfig?: string;
  vpnDedicatedIp?: string;
  temporalWorkflowId?: string;
  followedFor?: { workflowId: string; action: 'app-resize' | 'app-sync-config'; newStorage?: Record<string, string> | undefined } | undefined;
  lastSyncedAt?: string;
  llmApi?: { port: number; serviceSuffix?: string; apiPath?: string; model?: string };
  openWebuiTargetId?: string;
  hermesTargetId?: string;
  [key: string]: unknown;
}

export interface ModelEndpointMetadata {
  id: string;
  ownerId: string;
  name: string;
  baseUrl: string;
  model?: string;
  apiKeyEnc?: string;
  isMesh?: boolean;
  contextTokens?: number;
  /** Dollars per million tokens, as the gateway quoted them when the row was written. */
  pricing?: { promptPerMTok: number; completionPerMTok: number };
  /** Artificial Analysis Intelligence Index, when their catalogue has a match for this model. */
  intelligence?: number;
  createdAt: string;
  lastCheckedAt?: string;
  lastError?: string;
}

export type ProjectDeletionMode = 'archive' | 'permanent';

export interface ProjectRemoval {
  startedAt: string;
  requestedBy: string;
  mode: ProjectDeletionMode;
  phase: 'deleting' | 'archived';
}

export type ProjectDeletionAsked = Omit<ProjectRemoval, 'phase'>;

export interface ProjectMetadata {
  id: string;
  name: string;
  giteaOwner?: string;
  giteaRepo?: string;
  ownerId?: string;
  targetClusterId?: string;
  language?: string;
  appType: string;
  autoDeployOnBuild?: boolean; // default false — see RunPipelineActivity's promote step
  deployEnv?: string;
  needs?: { service: string; as?: string }[];
  webhookSecretEnc?: string; // AES-256-GCM encrypted (crypto.ts) — HMAC key for verifying Gitea's push webhook signature
  lastBuildStatus?: 'queued' | 'running' | 'succeeded' | 'failed';
  requiredSecrets?: { key: string; source: string }[];
  infisicalReaderEnc?: string;
  removal?: ProjectRemoval | undefined;
  releaseName?: string | undefined;
  release?: import('../../releases/index.js').ReleaseHow | undefined;
  channelId?: string | undefined;
  createdAt: string;
  /**
   * Where this project's leaves execute. Absent means the K8s sandbox (today's only behaviour).
   * A local device's `egress` is enforced when the device is running its leaves in a Docker
   * container (a local allowlist proxy — see `apps/local-agent/src/egress-proxy.ts`) and advisory
   * only when it's falling back to raw host execution (no proxy exists to enforce it there). Which
   * applies for a given run is decided by what the agent reports at connect time, not by this field.
   */
  executionTarget?: { kind: 'k8s' } | { kind: 'local-device'; deviceId: string; path?: string; egress?: LocalEgressRule[] };
  /**
   * Whether a local-device command needs a human's sign-off before it runs. Only meaningful
   * alongside `executionTarget.kind === 'local-device'` — the K8s sandbox has no plan mode.
   * Absent means 'plan' for a local device (the safer default) and 'auto' otherwise.
   */
  executionApproval?: 'plan' | 'auto';
  [key: string]: unknown;
}

export interface LocalAgentDeviceMetadata {
  id: string;
  ownerId: string;
  name: string;
  tokenHash?: string | undefined;
  issuedAt?: string | undefined;
  expiresAt?: string | undefined;
  nextTokenHash?: string | undefined;
  nextIssuedAt?: string | undefined;
  nextExpiresAt?: string | undefined;
  rootDir: string;
  meshIp?: string | undefined;
  createdAt: string;
  lastSeenAt?: string;
  os?: string | undefined;
  agents?: MachineAgent[] | undefined;
  agentsAt?: string | undefined;
  agentsNotSetUp?: string | undefined;
  manualAgents?: ManualMachineAgent[] | undefined;
  agentBundle?: string | undefined;
  agentUpdate?: AgentUpdateReport | undefined;
  koalaWanted?: { name: string } | undefined;
  koalaRefused?: { reason: string; at: string } | undefined;
  tokenRenewal?: { reason: string; failedAt: string } | undefined;
  [key: string]: unknown;
}

/**
 * A hostname allowlist entry for a local execution target's egress proxy. Exact match, no
 * wildcards — a CIDR wouldn't usefully name most real destinations (they sit behind rotating IPs
 * on a CDN), so this names the thing the CONNECT proxy actually sees: a hostname.
 */
export interface LocalEgressRule {
  host: string;
  ports?: number[];
}

export interface PendingApprovalMetadata {
  id: string;
  ownerId: string;
  leafId: string;
  projectId?: string;
  command: string;
  status: 'pending' | 'approved' | 'denied';
  createdAt: string;
  decidedAt?: string;
  [key: string]: unknown;
}

export interface PipelineRunMetadata {
  id: string;
  projectId: string;
  commitSha: string;
  ref: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  imageTag?: string;
  logFile?: string;
  temporalWorkflowId?: string;
  startedAt: string;
  finishedAt?: string;
  errorMessage?: string;
  commitMessage?: string;
  promotedAt?: string;
  deploymentId?: string;
  releaseRefused?: string;
  releaseSkipped?: string;
  releaseHeld?: string;
  [key: string]: unknown;
}

export interface OvhCredentials {
  applicationKey: string;
  applicationSecret: string;
  consumerKey: string;
  subsidiary: string;
}

export interface HuggingFaceCredentials {
  hfToken: string;
  defaultModel?: string;
}

/** artificialanalysis.ai — the Intelligence Index shown beside a model. */
export interface ArtificialAnalysisCredentials {
  apiKey: string;
}

export interface GoogleDriveCredentials {
  refreshToken: string;
  backupPassword?: string;
  email?: string;
}

export type DnsCredentialRecords = { [K in DnsProviderName]?: Record<string, string> };

export interface CloudCredentials extends DnsCredentialRecords {
  ovh?: OvhCredentials;
  huggingface?: HuggingFaceCredentials;
  artificialanalysis?: ArtificialAnalysisCredentials;
  googledrive?: GoogleDriveCredentials;
}

export const CLOUD_PROVIDERS = [
  'ovh',
  ...DNS_PROVIDER_NAMES,
  'huggingface', 'artificialanalysis', 'googledrive',
] as const;

export type CloudProvider = typeof CLOUD_PROVIDERS[number];

export function isCloudProvider(value: unknown): value is CloudProvider {
  return typeof value === 'string' && (CLOUD_PROVIDERS as readonly string[]).includes(value);
}

export type PlatformGrant = 'operator';

export interface SignInLink {
  issuer: string;
  subject: string;
}

export interface UserMetadata {
  sessionsEndedAt?: string | undefined;
  id: string;
  email: string;
  passwordHash?: string;
  signInLinks?: SignInLink[] | undefined;
  twoFactorEnabled: boolean;
  twoFactorSecret?: string;
  twoFactorPhone?: string;
  twoFactorPreferredMethod?: 'email' | 'sms';
  emailVerified: boolean;
  createdAt: string;
  credentials?: CloudCredentials;
  roles?: PlatformGrant[] | undefined;
  inviteAccounts?: number | undefined;
  extractionModelId?: string;
  /** The account's default engine: what a pack naming no endpoint of its own runs on. */
  defaultModelId?: string;
  /**
   * Make `defaultModelId` beat a pack's own engine rather than only filling in for one.
   *
   * Off, a pack that names an engine keeps it. On, everything runs on the default — and because
   * this is a flag rather than an edit to each pack, turning it off puts every pack back on what
   * it named.
   */
  globalModelOverride?: boolean;
  removal?: { startedAt: string; requestedBy: string } | undefined;
  space?: {
    person: string;
    checkRunId: string;
    scenarioId: string;
    models?: 'borrowed' | 'scripted' | undefined;
    script?: import('../../checks/index.js').CheckScript | undefined;
    world?: Record<string, unknown> | undefined;
  } | undefined;
}

export interface InviteMetadata {
  id: string;
  code?: string | undefined;
  codeHash?: string | undefined;
  expiresAt?: string | undefined;
  createdBy: string;
  createdAt: string;
  usedBy?: string;
  usedAt?: string;
  email?: string | undefined;
  project?: { name: string; role: string; join: string } | undefined;
  makesAccount?: boolean | undefined;
}

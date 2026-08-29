import type { AppType } from './app-catalog.js';
export type ClusterProviderName = 'k3d' | 'aws' | 'gcp' | 'azure' | 'do' | 'remote' | 'hetzner';

export interface ClusterProgress {
  step: string;
  message: string;
  timestamp: string;
}

export interface ClusterMetadata {
  id: string;
  name: string;
  provider: ClusterProviderName;
  status: 'provisioning' | 'healthy' | 'failed' | 'destroying' | 'discovered' | 'destroyed' | 'awaiting-key';
  kubeconfigPath?: string;
  lastLogPath?: string;
  temporalWorkflowId?: string;
  createdAt?: string;
  lastSyncedAt?: string;
  progress?: ClusterProgress;
  gpuEnabled?: boolean;
  capacity?: {
    cpuCores: number;
    ramGb: number;
    gpuCount?: number;
    gpuVendor?: 'nvidia' | 'amd';
  };
  isSystem?: boolean;
  ownerId?: string;
  remoteHost?: string;
  remoteUsername?: string;
  remoteSshPort?: number;
  meshIp?: string;
  remoteK3sApiPort?: number;
  remoteSshPrivateKeyEnc?: string;
  meshNodeId?: string;
  hetznerServerType?: string;
  hetznerLocation?: string;
  hetznerImage?: string;
  hetznerServerId?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

export interface DeploymentMetadata {
  id: string;
  name: string;
  deploymentId?: string;
  clusterId: string;
  ownerId?: string;
  strategy: 'helm' | 'native';
  appType?: AppType;
  gitappProjectId?: string;
  gitappImageTag?: string;
  status: 'deploying' | 'running' | 'failed' | 'unhealthy' | 'destroying' | 'discovered';
  healthReason?: string;
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
  publicHostname?: string;
  lastLogPath?: string;
  modules?: string[];
  storage?: Record<string, string>;
  vpnEnabled?: boolean;
  vpnProtocol?: 'wireguard' | 'openvpn';
  vpnConfig?: string;
  vpnDedicatedIp?: string;
  temporalWorkflowId?: string;
  lastSyncedAt?: string;
  llmApi?: { port: number; serviceSuffix?: string; apiPath?: string; model?: string };
  vllmModel?: string;
  vllmGpuCount?: number;
  vllmGpuVendor?: 'nvidia' | 'amd';
  vllmCachePvc?: string;
  vllmHfToken?: string;
  vllmMaxModelLen?: number;
  vllmGpuMemUtil?: number;
  vllmExtraArgs?: string;
  vllmToolCallingEnabled?: boolean;
  vllmToolCallParser?: 'granite-20b-fc' | 'granite' | 'hermes' | 'internlm' | 'jamba' | 'llama3_json' | 'mistral' | 'pythonic';
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
  minioRootUser?: string;
  minioRootPassword?: string;
  minioStorage?: string;
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
  gitappEnv?: string;
  appSettings?: Record<string, string>;
  openWebuiTargetId?: string;
  hermesTargetId?: string;
  webuiEnableWebSearch?: boolean;
  webuiWebSearchEngine?: 'duckduckgo' | 'tavily' | 'brave' | 'serper' | 'bing';
  webuiWebSearchApiKey?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

export interface ModelEndpointMetadata {
  id: string;
  ownerId: string;
  name: string;
  baseUrl: string;
  model?: string;
  apiKeyEnc?: string;
  isMesh?: boolean;
  createdAt: string;
  lastCheckedAt?: string;
  lastError?: string;
}

export interface ProjectMetadata {
  id: string;
  name: string;
  giteaOwner: string;
  giteaRepo: string;
  ownerId?: string;
  targetClusterId?: string;
  targetNamespace?: string;
  language?: string;
  appType: string;
  autoDeployOnBuild?: boolean; // default false — see RunPipelineActivity's promote step
  deployEnv?: string;
  needs?: { service: string; as?: string }[];
  webhookSecretEnc?: string; // AES-256-GCM encrypted (crypto.ts) — HMAC key for verifying Gitea's push webhook signature
  lastBuildStatus?: 'queued' | 'running' | 'succeeded' | 'failed';
  createdAt: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

export interface ClusterTaskArgs {
  name:     string;
  provider: ClusterProviderName;
  logFile:  string;
  activityId?: string;
}

export interface ClusterTaskResult {
  status:      'healthy' | 'failed';
  msg:         string;
  kubeconfig?: string;
  logFile:     string;
}

export interface DestroyClusterTaskArgs {
  name:       string;
  provider:   ClusterProviderName;
  logFile:    string;
  activityId: string;
}

export interface DestroyClusterTaskResult {
  status: string;
  msg:    string;
}

export interface DeployAppTaskArgs {
  name:       string;
  clusterId:  string;
  clusterName: string;
  provider:   ClusterProviderName;
  strategy:   string;
  appType?:   string;
  modules?:   string[];
  odooRepo:   string;
  odooTag:    string;
  dbRepo:     string;
  dbTag:      string;
  logFile:    string;
  activityId: string;
}

export interface DeployAppTaskResult {
  status:          string;
  msg:             string;
  displayUrl:      string;
  kubeconfig?:     string;
  logFile:         string;
}

export interface DestroyAppTaskArgs {
  name:          string;
  clusterId:     string;
  clusterName:   string;
  provider:      ClusterProviderName;
  strategy:      string;
  logFile:       string;
  activityId:    string;
}

export interface DestroyAppTaskResult {
  status: string;
  msg:    string;
}

export interface ResizeDiskTaskArgs {
  name:         string;
  clusterId:    string;
  clusterName:  string;
  provider:     ClusterProviderName;
  strategy:     string;
  appType:      string;
  storage:      Record<string, string>;
  logFile:      string;
  activityId:   string;
}

export interface ResizeDiskTaskResult {
  status:  string;
  msg:     string;
  logFile: string;
}

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
}

export interface GcpCredentials {
  projectId: string;
  serviceAccountJson: string;
}

export interface AzureCredentials {
  clientId: string;
  clientSecret: string;
  subscriptionId: string;
  tenantId: string;
}

export interface DoCredentials {
  token: string;
}

export interface HetznerCredentials {
  token: string;
}

export interface CloudflareCredentials {
  token?: string;
  zone?: string;
}

export interface VultrCredentials {
  token: string;
}

export interface LinodeCredentials {
  token: string;
}

export interface ScalewayCredentials {
  secretKey: string;
  accessKey?: string;
  projectId?: string;
}

export interface HostingerCredentials {
  token: string;
}

export interface ContaboCredentials {
  clientId: string;
  clientSecret: string;
  apiUser: string;
  apiPassword: string;
}

export interface HuggingFaceCredentials {
  hfToken: string;
  defaultModel?: string;
}

export interface GitHubCredentials {
  token: string;
  username?: string;
}

export interface GoogleDriveCredentials {
  refreshToken: string;
  backupPassword?: string;
  email?: string;
}

export interface CloudCredentials {
  aws?: AwsCredentials;
  gcp?: GcpCredentials;
  azure?: AzureCredentials;
  do?: DoCredentials;
  hetzner?: HetznerCredentials;
  cloudflare?: CloudflareCredentials;
  vultr?: VultrCredentials;
  linode?: LinodeCredentials;
  scaleway?: ScalewayCredentials;
  hostinger?: HostingerCredentials;
  contabo?: ContaboCredentials;
  huggingface?: HuggingFaceCredentials;
  github?: GitHubCredentials;
  googledrive?: GoogleDriveCredentials;
}

export const CLOUD_PROVIDERS = [
  'aws', 'gcp', 'azure', 'do', 'hetzner',
  'vultr', 'linode', 'scaleway', 'hostinger', 'contabo',
  'cloudflare',
  'huggingface', 'github', 'googledrive',
] as const;

export type CloudProvider = typeof CLOUD_PROVIDERS[number];

export function isCloudProvider(value: unknown): value is CloudProvider {
  return typeof value === 'string' && (CLOUD_PROVIDERS as readonly string[]).includes(value);
}

export interface UserMetadata {
  id: string;
  email: string;
  passwordHash?: string;
  githubId?: string;
  googleId?: string;
  twoFactorEnabled: boolean;
  twoFactorSecret?: string;
  twoFactorPhone?: string;
  twoFactorPreferredMethod?: 'email' | 'sms';
  emailVerified: boolean;
  createdAt: string;
  credentials?: CloudCredentials;
  isAdmin?: boolean;
  extractionModelId?: string;
}

export interface InviteMetadata {
  id: string;
  code: string;
  createdBy: string;
  createdAt: string;
  usedBy?: string;
  usedAt?: string;
}

export interface ClusterProgress {
  step: string;
  message: string;
  timestamp: string;
}

export interface ClusterMetadata {
  id: string;
  name: string;
  provider: 'k3d' | 'aws' | 'gcp' | 'azure' | 'do';
  status: 'provisioning' | 'healthy' | 'failed' | 'destroying' | 'discovered';
  kubeconfigPath?: string;
  lastLogPath?: string;
  temporalWorkflowId?: string;
  createdAt?: string;
  lastSyncedAt?: string;
  progress?: ClusterProgress;
  gpuEnabled?: boolean;
  // Marks the synthetic entry representing the always-on management cluster (see
  // ClusterService.getSystemClusterEntry) — never persisted to the DB, read-only in the UI,
  // and rejected by destroy/abort on the backend too.
  isSystem?: boolean;
  // Temporal-related extensions
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

export interface DeploymentMetadata {
  id: string;
  name: string;
  deploymentId?: string;
  clusterId: string;
  strategy: 'helm' | 'native';
  appType?: 'odoo' | 'wordpress' | 'nextcloud' | 'audiobookshelf' | 'prometheus' | 'traefik' | 'vllm' | 'openwebui';
  status: 'deploying' | 'running' | 'failed' | 'destroying' | 'discovered';
  webRepo?: string;
  webTag?: string;
  dbRepo?: string;
  dbTag?: string;
  url?: string;
  isExposed?: boolean; // derived: isExposedLocally || isExposedPublicly
  exposureUrl?: string; // derived "primary" URL for back-compat consumers: publicExposureUrl || localExposureUrl
  exposurePath?: string; // target route path, shared by both exposure modes
  isExposedLocally?: boolean;
  localExposureUrl?: string;
  isExposedPublicly?: boolean;
  publicExposureUrl?: string;
  lastLogPath?: string;
  modules?: string[]; // IDs of enabled custom modules
  storage?: Record<string, string>;
  vpnEnabled?: boolean;
  vpnProtocol?: 'wireguard' | 'openvpn';
  vpnConfig?: string;
  vpnDedicatedIp?: string;
  temporalWorkflowId?: string;
  lastSyncedAt?: string;
  // vLLM-specific fields
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
  // Open WebUI-specific fields
  openWebuiTargetId?: string; // id of the vLLM DeploymentMetadata this instance talks to
  // Temporal-related extensions
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

// ── Workflow / Task Arg types (used by @temporalio/workflow proxyActivities) ──

export interface ClusterTaskArgs {
  name:     string;
  provider: 'k3d' | 'aws' | 'gcp' | 'azure' | 'do';
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
  provider:   'k3d' | 'aws' | 'gcp' | 'azure' | 'do';
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
  provider:   'k3d' | 'aws' | 'gcp' | 'azure' | 'do';
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
  provider:      'k3d' | 'aws' | 'gcp' | 'azure' | 'do';
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
  provider:     'k3d' | 'aws' | 'gcp' | 'azure' | 'do';
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

/** Per-provider encrypted credential blobs stored on the user record */
export interface AwsCredentials {
  accessKeyId: string;       // encrypted
  secretAccessKey: string;   // encrypted
  region: string;            // plaintext
}

export interface GcpCredentials {
  projectId: string;              // plaintext
  serviceAccountJson: string;     // encrypted (full JSON blob)
}

export interface AzureCredentials {
  clientId: string;           // encrypted
  clientSecret: string;       // encrypted
  subscriptionId: string;     // plaintext
  tenantId: string;           // plaintext
}

export interface DoCredentials {
  token: string;              // encrypted
}

export interface HuggingFaceCredentials {
  hfToken: string;            // encrypted
  defaultModel?: string;      // plaintext
}

export interface GitHubCredentials {
  token: string;              // encrypted
  username?: string;          // plaintext
}

export interface CloudCredentials {
  aws?: AwsCredentials;
  gcp?: GcpCredentials;
  azure?: AzureCredentials;
  do?: DoCredentials;
  huggingface?: HuggingFaceCredentials;
  github?: GitHubCredentials;
}

export type CloudProvider = 'aws' | 'gcp' | 'azure' | 'do' | 'huggingface' | 'github';

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
}


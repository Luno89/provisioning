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
  appType?: 'odoo' | 'wordpress' | 'nextcloud' | 'audiobookshelf' | 'prometheus' | 'traefik';
  status: 'deploying' | 'running' | 'failed' | 'destroying' | 'discovered';
  webRepo?: string;
  webTag?: string;
  dbRepo?: string;
  dbTag?: string;
  url?: string;
  isExposed?: boolean;
  exposureUrl?: string;
  exposurePath?: string;
  lastLogPath?: string;
  modules?: string[]; // IDs of enabled custom modules
  storage?: Record<string, string>;
  vpnEnabled?: boolean;
  vpnProtocol?: 'wireguard' | 'openvpn';
  vpnConfig?: string;
  vpnDedicatedIp?: string;
  temporalWorkflowId?: string;
  lastSyncedAt?: string;
  // Temporal-related extensions
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

// ── Workflow / Task Arg types (used by @temporalio/workflow proxyActivities) ──

export interface ClusterTaskArgs {
  name:     string;
  provider: 'k3d' | 'aws' | 'gcp' | 'azure' | 'do';
  logFile:  string;
  activityId: string;
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

export interface CloudCredentials {
  aws?: AwsCredentials;
  gcp?: GcpCredentials;
  azure?: AzureCredentials;
  do?: DoCredentials;
}

export type CloudProvider = 'aws' | 'gcp' | 'azure' | 'do';

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


/**
 * Every provider a *cluster* can live on. Distinct from CloudProvider below, which is the set of
 * services credentials can be stored for (that one includes non-provisioning entries like
 * huggingface/github/googledrive, and excludes 'k3d'/'remote', which need no credentials).
 *
 * 'remote'  — an already-existing SSH-reachable machine (GPU workstation), bootstrapped in place.
 * 'hetzner' — a VM this platform creates and destroys itself, then bootstraps via that same
 *             'remote' path (distributed-systems plan Phase 3).
 */
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
  // 'destroyed' is terminal and only ever set by the Temporal destroy path (TemporalBridge's
  // trackWorkflow/reconcile loops). It was missing from this union while four call sites already
  // wrote it, so records were being persisted with a status the type said was impossible.
  //
  // Note the two destroy paths disagree: ClusterService.delete() removes the record outright,
  // while the Temporal path marks it 'destroyed' and leaves it. For k3d/mock clusters
  // reconcileAllClusters then prunes it (no container found), but a 'remote' or 'hetzner' record
  // has no such check and lingers. Worth reconciling separately — widening the type here only
  // stops it being a lie.
  // 'awaiting-key' is a bring-your-own-machine cluster whose generated public key the user has not
  // authorised yet. Nothing has been provisioned; no workflow is running. It is terminal until the
  // user calls POST /api/clusters/:id/start, so the reconciliation loop must leave it alone rather
  // than treating it as a stalled 'provisioning'.
  status: 'provisioning' | 'healthy' | 'failed' | 'destroying' | 'discovered' | 'destroyed' | 'awaiting-key';
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
  // The user who provisioned this cluster (see ClusterService.getAll/getById) — absent on
  // records created before per-user isolation existed; migrateLegacyOwnership backfills those
  // to the admin user once, at startup. Never set on the synthetic system-cluster entry (isSystem
  // above), which stays visible to every user regardless of ownerId — it's shared platform
  // infrastructure, not something any one user provisioned.
  ownerId?: string;
  // provider === 'remote' only — the SSH bootstrap target (distributed-systems plan Phase 2).
  // remoteHost is also what the kubeconfig's server field gets rewritten to (see
  // ProvisionRemoteHostActivity) — normally a Headscale mesh IP so this backend can reach a
  // machine that's behind NAT / has no public IP (a GPU workstation) with no port-forwarding.
  remoteHost?: string;
  remoteUsername?: string;
  remoteSshPort?: number;
  /**
   * The node's 100.64.x.x Headscale address, set when it joined the mesh during provisioning.
   *
   * Distinct from remoteHost, which is whatever address the kubeconfig was rewritten to. This one
   * is what public ingress proxies application traffic to: the root node reaches the cluster's
   * Traefik at `<meshIp>:<traefikNodePort>`, which is the only route in for a tenant machine that
   * has no inbound ports open (and, behind home NAT, could not open any).
   */
  meshIp?: string;
  // Only needed when the k3s API server isn't reachable at remoteHost's default port 6443 (e.g.
  // a port-forwarded test target) — see ProvisionRemoteHostActivity's doc comment.
  remoteK3sApiPort?: number;
  // AES-256-GCM encrypted (see lib/crypto.ts) — decrypted only inside TemporalBridge right
  // before building activity args; an SSH private key is materially more sensitive than the
  // other provider tokens already stored this way (e.g. DeploymentMetadata's vllmHfToken), so it
  // gets the encrypted-at-rest treatment those don't bother with.
  remoteSshPrivateKeyEnc?: string;
  // Headscale node id (see HeadscaleService) for the joined mesh device — lets a future "remove
  // this cluster" flow also revoke mesh access, not just uninstall k3s.
  meshNodeId?: string;
  // provider === 'hetzner' only — the VM this platform created for the cluster to live on.
  // Everything after the VM exists is handled by the 'remote' fields above (the public IP lands
  // in remoteHost, the injected key in remoteSshPrivateKeyEnc), because Phase 3's whole design is
  // that a created VM and a user-supplied machine are the same thing from that point on.
  hetznerServerType?: string;
  hetznerLocation?: string;
  hetznerImage?: string;
  // Numeric id from Hetzner's API, recorded at create time so a destroy can be *verified* against
  // the provider ("is this server actually gone?") rather than trusted because Terraform said so.
  hetznerServerId?: string;
  // Temporal-related extensions
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

export interface DeploymentMetadata {
  id: string;
  name: string;
  deploymentId?: string;
  clusterId: string;
  // The user who created this deployment — independent of who owns the cluster it's on (a
  // deployment on the shared system cluster still belongs to the person who deployed it, not to
  // everyone who can see that cluster). Absent on records created before per-user isolation
  // existed; migrateLegacyOwnership backfills those to the admin user once, at startup.
  ownerId?: string;
  strategy: 'helm' | 'native';
  appType?: 'odoo' | 'wordpress' | 'nextcloud' | 'audiobookshelf' | 'prometheus' | 'traefik' | 'vllm' | 'tabbyapi' | 'openwebui' | 'hermes' | 'gitapp' | 'palworld' | 'jellyfin' | 'plex' | 'navidrome' | 'kavita' | 'immich' | 'papra' | 'homeassistant';
  // gitapp-specific fields — image comes from a Project's pipeline run, not a typed repo/tag
  gitappProjectId?: string;
  gitappImageTag?: string;
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
  /**
   * The `<app>-<id>.<domain>` name this deployment is served at publicly, allocated on first
   * exposure and stable thereafter — re-exposing must not hand the user a different URL.
   *
   * Held separately from publicExposureUrl (which carries the scheme and is what the UI links to)
   * because the Caddy site block is keyed on the bare hostname.
   */
  publicHostname?: string;
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
  // TabbyAPI-specific fields
  tabbyModel?: string;
  tabbyRevision?: string;
  tabbyGpuCount?: number;
  tabbyHfToken?: string;
  tabbyCachePvc?: string;
  // Not a literal union: valid tags come from the registry at runtime (see
  // RegistryService.getTags/getLocalTags), not a fixed set baked into this type.
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
  // Schema-driven settings for app types with too many options to give each a first-class field
  // (game servers: ~120 apiece). One map threaded through the pipeline once, validated at runtime
  // against lib/app-settings-schema.ts instead of at compile time. See that file for why.
  //
  // Keyed by container env var name. Secrets are deliberately NOT stored here — they live in a
  // Kubernetes Secret so they never reach Mongo, Terraform state, or Temporal history.
  appSettings?: Record<string, string>;
  // Open WebUI-specific fields
  openWebuiTargetId?: string; // id of the vLLM/TabbyAPI DeploymentMetadata this instance talks to
  hermesTargetId?: string; // id of the vLLM/TabbyAPI DeploymentMetadata this Hermes Agent instance talks to
  webuiEnableWebSearch?: boolean;
  webuiWebSearchEngine?: 'duckduckgo' | 'tavily' | 'brave' | 'serper' | 'bing';
  webuiWebSearchApiKey?: string;
  // Temporal-related extensions
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

// ── CI/CD: sibling projects hosted on the self-hosted Gitea instance (see GiteaService) ──

export interface ProjectMetadata {
  id: string;
  name: string;
  giteaOwner: string;
  giteaRepo: string;
  targetClusterId?: string;
  targetNamespace?: string;
  appType: string; // deploy target app type once a build is promoted (see gitapp construct)
  autoDeployOnBuild?: boolean; // default false — see RunPipelineActivity's promote step
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

// ── Workflow / Task Arg types (used by @temporalio/workflow proxyActivities) ──

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

// Hetzner Cloud is a plain VM API, not a managed-Kubernetes service like EKS/GKE — a single
// token is all it needs (see credential-resolver's 'hetzner' case). The distributed-systems
// plan's Phase 3 uses it to create a VM, then hands the VM off to Phase 2's generic SSH k3s
// bootstrap, so nothing beyond VM lifecycle lives here.
export interface HetznerCredentials {
  token: string;              // encrypted
}

/** Cloudflare DNS. Used to create the root node's records; never touched by tenant provisioning. */
export interface CloudflareCredentials {
  /** Scoped API token — Zone → DNS → Edit is sufficient. Not a Global API Key. */
  token?: string;
  /** Optional convenience: the zone this token is scoped to, e.g. nowrinkles.dev. */
  zone?: string;
}

/**
 * The VPS providers below are all plain-VM hosts in the same mould as Hetzner: one API token (or
 * a small credential set) is enough to both price and provision. Connecting them unlocks that
 * provider in the VPS catalog, and is the prerequisite for a provisioning path later.
 */
export interface VultrCredentials {
  token: string;              // encrypted — Personal Access Token
}

export interface LinodeCredentials {
  token: string;              // encrypted — Personal Access Token
}

/** Scaleway authenticates API calls with the SECRET key; the access key is an identifier. */
export interface ScalewayCredentials {
  secretKey: string;          // encrypted
  accessKey?: string;         // plaintext — public half of the key pair
  projectId?: string;         // plaintext — needed to place orders, not to read the catalogue
}

export interface HostingerCredentials {
  token: string;              // encrypted — API token from hPanel
}

/**
 * Contabo is the odd one out: an OAuth2 password grant needing four values rather than a single
 * token. Note its API exposes no pricing endpoint, so these credentials enable management, not
 * catalogue pricing — see lib/vps-catalog/adapters.ts.
 */
export interface ContaboCredentials {
  clientId: string;           // encrypted
  clientSecret: string;       // encrypted
  apiUser: string;            // plaintext — the account email
  apiPassword: string;        // encrypted
}

export interface HuggingFaceCredentials {
  hfToken: string;            // encrypted
  defaultModel?: string;      // plaintext
}

export interface GitHubCredentials {
  token: string;              // encrypted
  username?: string;          // plaintext
}

// Not a provisioning target like the others above — a backup destination connected via OAuth
// (see /api/credentials/googledrive/connect) rather than a pasted API key. refreshToken is what
// scripts/backup-to-drive.sh uses (via generate-rclone-config.ts) to authenticate as this Drive
// account; backupPassword is the passphrase that rclone's crypt remote encrypts apps/backend/.env
// with before upload, since that file alone can decrypt every other stored credential.
export interface GoogleDriveCredentials {
  refreshToken: string;       // encrypted
  backupPassword?: string;    // encrypted
  email?: string;             // plaintext — which Google account this is, for display
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

export type CloudProvider =
  | 'aws' | 'gcp' | 'azure' | 'do' | 'hetzner'
  | 'vultr' | 'linode' | 'scaleway' | 'hostinger' | 'contabo'
  // Not a compute provider — DNS only, for the platform's own records.
  | 'cloudflare'
  | 'huggingface' | 'github' | 'googledrive';

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
  // The very first account ever registered becomes admin automatically (see
  // migrateLegacyOwnership / the register route) — the only account that can mint invite codes.
  // Not a general RBAC system, just enough to gate registration on an invite-only root node.
  isAdmin?: boolean;
}

// ── Invite-gated registration (root-node hosting — see /api/auth/register) ──
export interface InviteMetadata {
  id: string; // same value as `code` — the code itself is the natural primary key
  code: string;
  createdBy: string; // admin user id who minted this code
  createdAt: string;
  usedBy?: string; // user id who registered with this code
  usedAt?: string;
}


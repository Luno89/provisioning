import type { AppType } from './app-catalog.js';
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
  /**
   * Measured capacity of the largest single node, read from `status.allocatable` at the end of
   * provisioning (see lib/cluster-capacity.ts). Absent on clusters provisioned before this existed
   * — treated as "unknown", never as zero, so deploy preflight skips rather than blocks.
   *
   * `ramGb` is SYSTEM RAM and never VRAM. Kubernetes exposes GPUs as a count and no VRAM figure
   * exists to record here; see the cluster-capacity docstring for why that is structural rather
   * than an omission.
   */
  capacity?: {
    cpuCores: number;
    ramGb: number;
    gpuCount?: number;
    gpuVendor?: 'nvidia' | 'amd';
  };
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
  appType?: AppType;
  // gitapp-specific fields — image comes from a Project's pipeline run, not a typed repo/tag
  gitappProjectId?: string;
  gitappImageTag?: string;
  /**
   * `failed` and `unhealthy` are different events and are deliberately not merged.
   *
   * `failed` means the deploy itself did not complete — the apply errored, the image would not
   * build, the workflow was cancelled. Nothing is running because nothing was placed.
   *
   * `unhealthy` means the deploy worked and the workload does not. The objects exist and are
   * correct; the container inside them crashes, or its image cannot be pulled. Collapsing the two
   * sent people to the deploy logs for a problem the deploy logs cannot show, because the deploy
   * succeeded.
   */
  status: 'deploying' | 'running' | 'failed' | 'unhealthy' | 'destroying' | 'discovered';
  /** Why the workload is unhealthy, e.g. "koala-web-7d4f: CrashLoopBackOff". Empty when healthy. */
  healthReason?: string;
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
  /**
   * Marks a deployment as serving an OpenAI-compatible API when the catalogue in lib/llm-apps.ts
   * cannot know — a gitapp the user built, or an engine the platform does not package yet.
   *
   * The catalogue always WINS over this for a known app type: platform-packaged values are
   * authoritative, and letting a stored field override them would reintroduce the drift the
   * catalogue exists to remove. This is the one place user-supplied values enter the deployed-app
   * path, so it is opt-in and explicit rather than inferred.
   */
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
  /**
   * ── The agent's own web access (see lib/web-tools.ts) ──
   *
   * These two credentials are stored rather than left to the constructs to generate, because the
   * agent has to present the same secret the service was deployed with. A construct-generated one
   * is unknowable to everything except the pod holding it.
   */
  searxngSecretKey?: string;
  /** Comma-separated engine names to restrict SearXNG to. Empty means its own default set. */
  searxngEngines?: string;
  crawl4aiApiToken?: string;
  crawl4aiMemoryLimit?: string;
  crawl4aiShmSize?: string;
  /**
   * The four search services. Credentials are stored rather than left to the constructs to
   * generate: Quickwit has to be given the same keys MinIO was deployed with, and a value
   * generated inside a construct is unknowable to every other deployment — the same reason
   * searxngSecretKey and crawl4aiApiToken are here.
   */
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
  /** The package mirror sandboxes install through — see constructs/verdaccio-native.ts. */
  verdaccioUpstream?: string;
  verdaccioStorage?: string;
  /**
   * Environment for a deployed project, one "KEY=VALUE" per line.
   *
   * Without it a built project has nowhere to be told anything, so anything needing a token or an
   * upstream URL deploys and immediately exits.
   */
  gitappEnv?: string;
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

/**
 * A user-registered OpenAI-compatible API — Ollama on their laptop, llama.cpp, LM Studio, a vLLM
 * they run outside the platform, or a hosted provider.
 *
 * Separate from DeploymentMetadata because the platform did not create it and cannot manage its
 * lifecycle; all it has is an address and, sometimes, a key.
 */
export interface ModelEndpointMetadata {
  id: string;
  ownerId: string;
  name: string;
  /** Base URL through /v1, e.g. http://100.64.0.7:11434/v1 — validated by endpoint-url-safety.ts. */
  baseUrl: string;
  /** Model id to send upstream. Blank means "whatever the endpoint defaults to". */
  model?: string;
  /** AES-256-GCM (crypto.ts). Never returned to a client, masked in list responses. */
  apiKeyEnc?: string;
  /**
   * True when baseUrl's host is in the mesh CGNAT range. Recorded at registration because it
   * decides whether the ownership check against the caller's Headscale devices applies — the root
   * node can reach every tenant's machines, so a mesh address must be proven to be the
   * registrant's own.
   */
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
  // Optional because projects created before ownership existed have none. Those are treated as
  // admin-only rather than world-visible — see ownsProject in index.ts.
  ownerId?: string;
  targetClusterId?: string;
  targetNamespace?: string;
  /**
   * The toolchain this project's code needs to build and run.
   *
   * ── WHY HERE AND NOT ON THE PERSONA ──
   * A persona is an agent's environment: its tools, its network, its budget, its prompt. A
   * toolchain is a dependency of the CODE. Conflating them produced "Builder (go)" and
   * "Builder (python)" — the same worker duplicated per workpiece, which multiplies with every
   * project and says nothing about how the agent behaves.
   *
   * A tree uses many personas: one frames the questions, one researches, one builds, one lands the
   * result. All of them working in a Go repository need Go. That is one fact about the project, not
   * four facts about four agents.
   *
   * Absent takes the platform default.
   */
  language?: string;
  appType: string; // deploy target app type once a build is promoted (see gitapp construct)
  autoDeployOnBuild?: boolean; // default false — see RunPipelineActivity's promote step
  /**
   * Environment the built image needs to run, one "KEY=VALUE" per line.
   *
   * On the PROJECT rather than the deployment because it outlives any single build — every image
   * this repository produces needs the same token.
   */
  deployEnv?: string;
  /**
   * Services this project's deployment depends on, provided as service bindings.
   *
   * Declared here rather than per-deploy: this is a property of the SERVICE, so every deploy and
   * every redeploy binds the same things. It is also the decision worth approving — the credential
   * copy that follows is a mechanical consequence, and an approval seen on every deploy is one that
   * gets clicked through.
   */
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
  /**
   * Provider id used for structured extraction — turning a conversation into proposed leaves.
   *
   * A separate model on purpose: the conversation model reasons, which is what makes it good to
   * talk to and unreliable at emitting a format (measured at roughly one success in eight). This
   * points at any provider in the registry, deployment or registered endpoint. Unset means no
   * extractor, and /plan falls back to parsing the conversation model's own reply.
   */
  extractionModelId?: string;
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


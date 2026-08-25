import type { Persona } from '@koala/harness-types';
import type { Conversation } from './conversations.js';
import type { StoredAppSpec } from './app-spec.js';
import { MemoryDB } from './memory-db.js';
import { MongoDB } from './mongo-db.js';
import type { Branch, Leaf } from './leaves.js';
import type { Tree } from './trees.js';
import type { CorpusPage } from './corpus.js';
import type { FrontierUrl, FrontierClaim } from './frontier.js';
import type { LeafTrace, LeafEvidence } from './leaf-trace.js';
import type { AgentStep } from '@koala/harness-types';
import type { GiteaAccount } from './projects.js';
import type { Experiment } from './experiments.js';
import type { HarnessProfile } from './harness-profile.js';
import type { MemoryItem } from './memory-store.js';
import type { TreeTypeSpec } from './tree-types.js';
import type { ToolRepositoryItem } from './tool-repository.js';
import type { ModelThinkingProfile } from './thinking-classifier.js';
import type { ClusterProviderSpec } from './cluster-providers.js';
import type { ClusterMetadata, ClusterProgress, DeploymentMetadata, UserMetadata, ProjectMetadata, PipelineRunMetadata, InviteMetadata, ModelEndpointMetadata } from './types.js';

/**
 * Like Partial<T>, but each property may also be *explicitly* undefined.
 *
 * Under exactOptionalPropertyTypes, `Partial<T>` means "the key may be absent", NOT "the value may
 * be undefined" — so `{ storage: maybeUndefined }` is rejected. Every `save*Info` implementation
 * already filters with `if (x !== undefined)` before writing, so passing an explicit undefined is
 * both safe and the natural thing every caller does when spreading optional values.
 */
export type PartialInfo<T> = { [K in keyof T]?: T[K] | undefined };

export interface Database {
  init(): Promise<void>;
  close(): Promise<void>;

  getClusters(): Promise<ClusterMetadata[]>;
  saveCluster(cluster: ClusterMetadata): Promise<void>;
  saveClusterList(clusters: ClusterMetadata[]): Promise<void>;
  saveClusterInfo(cluster: PartialInfo<ClusterMetadata>): Promise<ClusterMetadata>;
  updateClusterProgress(clusterId: string, progress: ClusterProgress): Promise<void>;

  getDeployments(): Promise<DeploymentMetadata[]>;
  saveDeployment(deployment: DeploymentMetadata): Promise<void>;
  saveDeploymentList(deployments: DeploymentMetadata[]): Promise<void>;
  /** Removes one deployment, rather than rewriting the whole collection to drop it. */
  deleteDeployment(id: string): Promise<void>;
  saveDeploymentInfo(deployment: PartialInfo<DeploymentMetadata>): Promise<DeploymentMetadata>;

  getUsers(): Promise<UserMetadata[]>;
  saveUser(user: UserMetadata): Promise<void>;
  saveUserList(users: UserMetadata[]): Promise<void>;
  getUserByEmail(email: string): Promise<UserMetadata | undefined>;
  getUserById(id: string): Promise<UserMetadata | undefined>;

  getProjects(): Promise<ProjectMetadata[]>;
  saveProject(project: ProjectMetadata): Promise<void>;
  saveProjectInfo(project: PartialInfo<ProjectMetadata>): Promise<ProjectMetadata>;

  getPipelineRuns(): Promise<PipelineRunMetadata[]>;
  savePipelineRun(run: PipelineRunMetadata): Promise<void>;
  savePipelineRunInfo(run: PartialInfo<PipelineRunMetadata>): Promise<PipelineRunMetadata>;

  getInvites(): Promise<InviteMetadata[]>;
  saveInvite(invite: InviteMetadata): Promise<void>;

  getExperiments(): Promise<Experiment[]>;
  saveExperiment(experiment: Experiment): Promise<void>;
  deleteExperiment(id: string): Promise<void>;

  /** Keyed by ownerId — the promoted harness settings in force for one user. */
  getHarnessProfile(ownerId: string): Promise<HarnessProfile | null>;
  saveHarnessProfile(profile: HarnessProfile): Promise<void>;

  /** Owner-filtered by the caller, like leaves and experiments — never trust the id alone. */
  /**
   * Project types, owned and editable — see lib/tree-types.ts for why they stopped being a constant.
   * `ownerId` narrows, because a type id is unique per owner rather than globally.
   */
  getTreeTypes(ownerId?: string): Promise<TreeTypeSpec[]>;
  saveTreeType(treeType: TreeTypeSpec): Promise<void>;
  deleteTreeType(id: string, ownerId: string): Promise<void>;

  getPersonas(): Promise<Persona[]>;
  savePersona(persona: Persona): Promise<void>;
  deletePersona(id: string): Promise<void>;
  deleteHarnessProfile(ownerId: string): Promise<void>;

  /** Keyed by ownerId — one Gitea account per platform user. */
  getGiteaAccount(ownerId: string): Promise<GiteaAccount | null>;
  saveGiteaAccount(account: GiteaAccount): Promise<void>;

  /**
   * Crawled pages. Read by search, never handed to a model whole — see lib/corpus.ts.
   *
   * `getCorpusPages` is scoped by ingest or project rather than fetching everything: a corpus is
   * megabytes by design, and "load it all then filter" is the shape that works until the day it
   * does not.
   */
  getCorpusPages(filter: { ownerId: string; ingestId?: string; projectId?: string }): Promise<CorpusPage[]>;
  saveCorpusPages(pages: CorpusPage[]): Promise<void>;
  deleteCorpus(ingestId: string): Promise<void>;

  /**
   * The queue of URLs an ingest still owes — see lib/frontier.ts for why it is here and not in the
   * workflow that drives it.
   *
   * `enqueueFrontier` is the deduplication point: ids are derived from the URL, so re-offering a
   * page already queued is a no-op the index performs, and the count that comes back is how many
   * were genuinely new.
   *
   * `claimFrontier` does NOT mutate. It returns the next pages in a total order, so an activity
   * that Temporal retries is handed exactly what it was handed the first time; the batch is closed
   * by `completeFrontier` once its pages are actually stored.
   */
  enqueueFrontier(urls: FrontierUrl[]): Promise<number>;
  claimFrontier(ingestId: string, limit: number): Promise<FrontierClaim[]>;
  completeFrontier(ingestId: string, urls: string[]): Promise<void>;
  countFrontier(ingestId: string): Promise<number>;
  deleteFrontier(ingestId: string): Promise<void>;

  /**
   * A leaf's turn-by-turn record. Its own collection rather than a field on the leaf, because
   * getLeaves() returns every leaf and a trace is the largest thing one produces — see
   * lib/leaf-trace.ts.
   */
  getLeafTrace(leafId: string): Promise<LeafTrace | null>;
  saveLeafTrace(trace: LeafTrace): Promise<void>;
  /**
   * Appends one turn as it happens, so a run can be watched rather than only replayed.
   *
   * An append rather than a rewrite of the whole record: the document grows with every turn, and
   * replacing it each time would write the trace forty times over. It also means a leaf whose
   * activity is killed mid-run keeps what it had done — the end-of-run write alone lost everything
   * for exactly the crashes worth reading.
   */
  appendLeafStep(trace: Omit<LeafTrace, 'steps'> & { step: AgentStep }): Promise<void>;
  /**
   * Attaches evidence to an existing trace, without rewriting it.
   *
   * Targeted rather than a read-modify-write of the whole trace, because `saveLeafTrace` is a FULL
   * REPLACE and is written BEFORE verification runs — so a naive save here would race with, and
   * clobber, the steps the run had already recorded.
   */
  saveLeafEvidence(leafId: string, evidence: LeafEvidence): Promise<void>;
  deleteLeafTrace(leafId: string): Promise<void>;

  getTrees(): Promise<Tree[]>;
  saveTree(tree: Tree): Promise<void>;
  deleteTree(id: string): Promise<void>;

  getBranches(): Promise<Branch[]>;
  saveBranch(branch: Branch): Promise<void>;
  deleteBranch(id: string): Promise<void>;

  /**
   * Deployable app types as DATA — see lib/app-spec.ts.
   *
   * Seeded from the repo on setup so a fresh clone is functional, then editable at runtime. One
   * runtime source, so there is no second lookup path to drift from this one.
   */
  getAppSpecs(): Promise<StoredAppSpec[]>;
  saveAppSpec(spec: StoredAppSpec): Promise<void>;
  deleteAppSpec(id: string): Promise<void>;

  /**
   * Cluster providers as DATA — see lib/cluster-providers.ts.
   * Seeded from the repo on boot, then editable; the wizard reads these instead of a literal.
   */
  getClusterProviders(): Promise<ClusterProviderSpec[]>;
  saveClusterProvider(provider: ClusterProviderSpec): Promise<void>;

  /** General chat with Koala — threads, not branches. See lib/conversations.ts for why. */
  getConversations(): Promise<Conversation[]>;
  saveConversation(conversation: Conversation): Promise<void>;
  deleteConversation(id: string): Promise<void>;

  getLeaves(): Promise<Leaf[]>;
  saveLeaf(leaf: Leaf): Promise<void>;
  deleteLeaf(id: string): Promise<void>;

  getModelEndpoints(): Promise<ModelEndpointMetadata[]>;
  saveModelEndpoint(endpoint: ModelEndpointMetadata): Promise<void>;
  deleteModelEndpoint(id: string): Promise<void>;

  getMemories(ownerId?: string): Promise<MemoryItem[]>;
  saveMemory(memory: MemoryItem): Promise<void>;
  deleteMemory(id: string): Promise<void>;

  getTools(): Promise<ToolRepositoryItem[]>;
  saveTool(tool: ToolRepositoryItem): Promise<void>;
  deleteTool(id: string): Promise<void>;

  getModelThinkingProfile?(modelId: string): Promise<ModelThinkingProfile | null>;
  saveModelThinkingProfile?(profile: ModelThinkingProfile): Promise<void>;
}

export function createDatabase(): Database {
  if (process.env.NODE_ENV === 'test' && !process.env.IS_E2E) {
    return new MemoryDB();
  }
  return new MongoDB();
}
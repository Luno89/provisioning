import { BSON, type Db, type Document } from 'mongodb';
import type { AccountCollection } from '../../accounts/index.js';
import type { Database } from '../../platform/index.js';
import { SKIPPED_COLLECTIONS, type SkippedCollection } from './instance-move.js';

const BATCH = 500;

export async function* exportLines(db: Db): AsyncGenerator<string> {
  const collections = (await db.listCollections({}, { nameOnly: true }).toArray())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith('system.') && !SKIPPED_COLLECTIONS.includes(name))
    .sort();
  for (const name of collections) {
    for await (const doc of db.collection(name).find({})) {
      yield `${JSON.stringify({ c: name, d: BSON.EJSON.serialize(doc, { relaxed: false }) })}\n`;
    }
  }
}

export async function importLines(lines: AsyncIterable<string>, db: Db): Promise<number> {
  const reading = lines[Symbol.asyncIterator]();
  await db.dropDatabase();
  let collection = '';
  let batch: Document[] = [];
  let count = 0;
  const flush = async () => {
    if (batch.length) await db.collection(collection).insertMany(batch, { ordered: false });
    count += batch.length;
    batch = [];
  };
  for (let next = await reading.next(); !next.done; next = await reading.next()) {
    const line = next.value;
    if (!line.trim()) continue;
    const entry = JSON.parse(line) as { c: string; d: Document };
    if (entry.c !== collection) {
      await flush();
      collection = entry.c;
    }
    batch.push(BSON.EJSON.deserialize(entry.d, { relaxed: false }) as Document);
    if (batch.length >= BATCH) await flush();
  }
  await flush();
  return count;
}

type Stores = { [A in keyof Database as Database[A] extends (...args: never[]) => unknown ? never : A]: Database[A] };
type Call<A extends keyof Stores, M extends keyof Stores[A]> = Stores[A][M] extends (...args: infer P) => infer R ? { args: P; result: R } : never;
type One<T> = T extends readonly (infer E)[] ? E : T;
type Args<A extends keyof Stores, M extends keyof Stores[A]> = Call<A, M>['args'];
type Written<A extends keyof Stores, M extends keyof Stores[A], I extends number = 0> = One<Args<A, M>[I]>;
type Read<A extends keyof Stores, M extends keyof Stores[A]> = Call<A, M>['result'] extends AsyncIterable<infer E> ? E : One<NonNullable<Awaited<Call<A, M>['result']>>>;

export type MovedCollection = Exclude<AccountCollection, SkippedCollection>;

type Shaped<T extends Record<MovedCollection, unknown>> = T;

export type StoredShapes = Shaped<{
  accessRequests: Written<'infrastructure', 'saveAccessRequest'>;
  actionProposals: Written<'engine', 'saveActionProposal'>;
  appSpecs: Written<'infrastructure', 'saveAppSpec'>;
  artifactChunks: { artifactId: string; n: number; data: Uint8Array };
  artifacts: Read<'files', 'oldArtifacts'>;
  authoredExtensions: Written<'engine', 'saveAuthoredExtension'>;
  bindingTypes: Written<'infrastructure', 'saveBindingType'>;
  branches: Written<'projects', 'saveBranch'>;
  clusters: Written<'infrastructure', 'saveCluster'>;
  conversations: Written<'engine', 'saveConversation'>;
  corpus: Written<'engine', 'saveCorpusPages'>;
  deferredConclusions: Written<'memory', 'saveDeferredConclusion'>;
  deployments: Written<'infrastructure', 'saveDeployment'>;
  egressGrants: Written<'infrastructure', 'saveEgressGrant'>;
  egressRequests: Written<'infrastructure', 'saveEgressRequest'>;
  enginePersonas: Written<'engine', 'saveEnginePersona'>;
  engineRunEffort: Written<'engine', 'saveRunEffort'>;
  engineRunTraces: Written<'engine', 'saveRunTraces'>;
  engineTools: Written<'engine', 'saveEngineTool'>;
  evalAgentChanges: Written<'checks', 'saveEvalRecord', 1>;
  evalCases: Written<'checks', 'saveEvalRecord', 1>;
  evalLevel1Runs: Written<'checks', 'saveEvalRecord', 1>;
  evalPrompts: Written<'checks', 'saveEvalRecord', 1>;
  evalRuns: Written<'checks', 'saveEvalRecord', 1>;
  evalScenarioProposals: Written<'checks', 'saveEvalRecord', 1>;
  evalScenarioRuns: Written<'checks', 'saveEvalRecord', 1>;
  evalScenarios: Written<'checks', 'saveEvalRecord', 1>;
  clientSessions: Written<'instances', 'saveClientSession'>;
  fileShares: Written<'files', 'saveFileShare'>;
  giteaTokensToRevoke: Written<'projects', 'saveTokenToRevoke'>;
  hubLinks: Written<'hub', 'saveHubLink'>;
  instanceJoinTokens: Written<'instances', 'saveJoinToken'>;
  instanceWatches: Read<'instances', 'getWatches'>;
  instances: Written<'instances', 'saveInstance'>;
  leaves: Written<'projects', 'saveLeaf'>;
  localAgentDevices: Written<'machines', 'saveLocalAgentDevice'>;
  machineJoinCodes: Written<'machines', 'saveMachineJoinCode'>;
  mcpRequests: Written<'engine', 'saveMcpRequest'>;
  mcpServers: Written<'engine', 'saveMcpServer'>;
  mcpToolHints: Read<'engine', 'getMcpToolHints'>;
  memories: Written<'memory', 'saveMemory'>;
  modelEndpoints: Written<'models', 'saveModelEndpoint'>;
  monitoringAlertEpisodes: Written<'monitoring', 'saveAlertEpisode'>;
  monitoringAlertRules: Written<'monitoring', 'saveAlertRule'>;
  monitoringSettings: Written<'monitoring', 'saveMonitoringSetting'>;
  movesIn: Written<'infrastructure', 'saveMoveIn'>;
  odooReleases: Written<'releases', 'saveOdooRelease'>;
  passwordResets: Written<'accounts', 'savePasswordReset'>;
  pendingApprovals: Written<'infrastructure', 'savePendingApproval'>;
  planProposals: Written<'projects', 'savePlanProposal'>;
  procedures: Written<'engine', 'saveProcedure'>;
  projects: Written<'projects', 'saveProject'>;
  provisioning: Written<'infrastructure', 'openProvisioning'>;
  publishedWorkspaces: Written<'engine', 'savePublishedWorkspace'>;
  pushSubscriptions: Written<'monitoring', 'savePushSubscription'>;
  poisoningSignals: Written<'engine', 'savePoisoningSignal'>;
  releaseWithdrawalNotices: { key: Args<'instances', 'recordWithdrawalTold'>[0]; ownerId: Args<'instances', 'recordWithdrawalTold'>[1]; at: Args<'instances', 'recordWithdrawalTold'>[2] };
  runEndings: Written<'engine', 'saveRunEnded'>;
  runGrants: Written<'engine', 'saveRunGrant'>;
  runReads: Read<'engine', 'getRunReadsOfRuns'>;
  secretRequests: Written<'projects', 'saveSecretRequest'>;
  serverOrders: Written<'infrastructure', 'saveServerOrder'>;
  tasks: Written<'projects', 'saveTask'>;
  toolGrants: Written<'engine', 'saveToolGrant'>;
  trees: Written<'projects', 'saveTree'>;
  treeTypes: Written<'projects', 'saveTreeType'>;
  twoFactorCodes: Written<'accounts', 'saveTwoFactorCode'>;
  workFailures: Written<'infrastructure', 'addWorkFailure'>;
  scriptedRequests: Written<'checks', 'saveScriptedRequest'>;
  storedFiles: Written<'files', 'beginStoredFile'>;
  turnLogs: Written<'engine', 'appendTurnLog'>;
  workspaceDependencies: Written<'engine', 'saveWorkspaceDependency'>;
  workspaceImages: Written<'engine', 'saveWorkspaceImage'>;
  autoModeSettings: Written<'engine', 'saveAutoModeSettings'>;
  benchSettings: Written<'checks', 'saveBenchSettings', 1>;
  benchStates: Written<'checks', 'saveBenchState'>;
  extensionSettings: Written<'engine', 'saveExtensionSettings'>;
  giteaAccounts: Written<'projects', 'saveGiteaAccount'>;
  keeperSettings: Written<'memory', 'saveKeeperSettings'>;
  notificationSettings: Written<'monitoring', 'saveNotificationSettings'>;
  memoryWatermarks: { key: Args<'memory', 'saveMemoryWatermark'>[0]; value: Args<'memory', 'saveMemoryWatermark'>[1] };
  crawl_frontier: Written<'engine', 'enqueueFrontier'>;
  pipelineRuns: Written<'releases', 'savePipelineRun'>;
  hubSnapshots: { projectId: Args<'hub', 'saveHubSnapshot'>[0]; kind: Args<'hub', 'saveHubSnapshot'>[1]; doc: Args<'hub', 'saveHubSnapshot'>[2] };
  oidcArtifacts: Written<'instances', 'oidcUpsert', 2>;
  users: Written<'accounts', 'saveUser'>;
  dependencyChecks: Written<'instances', 'saveDependencyCheck'>;
  dependencyFindings: Written<'instances', 'saveDependencyFindings'>;
  dependencyStates: Written<'platform', 'saveDependencyState'>;
  endedSessions: Written<'platform', 'endSession'>;
  fenceAcks: { closing: Args<'platform', 'ackFence'>[0]; process: Args<'platform', 'ackFence'>[1]; at: Args<'platform', 'ackFence'>[2] };
  fences: Read<'platform', 'fencesRaised'>;
  hubDirty: Read<'hub', 'hubDirty'>;
  hubSignIn: Written<'instances', 'saveHubSignInKey'>;
  identityHandoffs: { jti: Args<'instances', 'claimHandoff'>[0]; expiresAt: Args<'instances', 'claimHandoff'>[1] };
  instanceReleases: Written<'instances', 'recordRelease'>;
  inviteLimits: Written<'accounts', 'saveInviteLimits'>;
  invites: Written<'accounts', 'saveInvite'>;
  koalaProcesses: Written<'platform', 'beatProcess'>;
  logoutDeliveries: Written<'instances', 'enqueueLogout'>;
  migrations: Written<'platform', 'recordMigration'>;
  model_thinking_profiles: Written<'models', 'saveModelThinkingProfile'>;
  pendingSignUps: Written<'accounts', 'savePendingSignUp'>;
  poolSettings: Written<'instances', 'savePoolPolicy'>;
  sessionRevocations: Written<'instances', 'recordRevocation'>;
  signInAttempts: Read<'platform', 'attemptsOf'>;
  toolCallParsers: Written<'models', 'saveToolCallParser'>;
}>;

type NamesCluster = `${string}cluster${string}` | `${string}Cluster${string}`;
type Leaf = string | number | boolean | bigint | symbol | Date | Uint8Array | ((...args: never[]) => unknown);
type Below = [never, 0, 1, 2, 3, 4, 5, 6];
type ValuesOf<T> = T[keyof T];
type FieldPaths<K extends string, V, D extends number> =
  V extends readonly (infer E)[]
    ? (K extends NamesCluster ? (NonNullable<E> extends string ? `${K}[]` : never) : never) | `${K}[].${PathsIn<NonNullable<E>, Below[D]>}`
    : (K extends NamesCluster ? (V extends string ? K : never) : never) | `${K}.${PathsIn<V, Below[D]>}`;
type PathsIn<T, D extends number> = [D] extends [never] ? never : T extends Leaf ? never : T extends object
  ? ValuesOf<{ [K in keyof T as K extends string ? (string extends K ? never : K) : never]-?: K extends string ? FieldPaths<K, NonNullable<T[K]>, D> : never }>
  : never;

export type ClusterField<C extends MovedCollection> = PathsIn<StoredShapes[C], 6>;

type Listed = { readonly [C in MovedCollection]?: readonly ClusterField<C>[] };
type ListedIn<L, C extends MovedCollection> = L extends { readonly [K in C]: readonly (infer F)[] } ? F : never;
type UnlistedIn<L, C extends MovedCollection> = Exclude<ClusterField<C>, ListedIn<L, C>>;
type Unlisted<L extends Listed> = { [C in MovedCollection as [UnlistedIn<L, C>] extends [never] ? never : C]: UnlistedIn<L, C> };

const everyField = <const L extends Listed>(fields: L & (keyof Unlisted<L> extends never ? unknown : { unlisted: Unlisted<L> })): L => fields;

export const CLUSTER_FIELDS = everyField({
  conversations: ['messages[].notice.refs.clusterId'],
  deployments: ['clusterId'],
  monitoringAlertEpisodes: ['clusterId'],
  monitoringAlertRules: ['clusterId'],
  monitoringSettings: ['clusterId'],
  projects: ['targetClusterId'],
  provisioning: ['target.clusterId'],
});

const KEYED_BY_CLUSTER: { readonly [C in MovedCollection]?: ClusterField<C> } = {
  monitoringSettings: 'clusterId',
};

export type RecordRetarget =
  | { kind: 'set'; collection: MovedCollection; filter: Document; update: Document; arrayFilters?: Document[] }
  | { kind: 'rekey'; collection: MovedCollection; from: string; to: string };

const MOVED = 'moved';

function retargetOf(collection: MovedCollection, field: string, from: string, to: string): RecordRetarget {
  if (KEYED_BY_CLUSTER[collection] === field) return { kind: 'rekey', collection, from, to };
  const segments = field.split('.');
  const filter = { [segments.map((segment) => segment.replace(/\[\]$/, '')).join('.')]: from };
  const last = segments.findLastIndex((segment) => segment.endsWith('[]'));
  if (last < 0) return { kind: 'set', collection, filter, update: { $set: { [field]: to } } };
  const set = segments.map((segment, at) => (segment.endsWith('[]') ? `${segment.slice(0, -2)}.${at === last ? `$[${MOVED}]` : '$[]'}` : segment)).join('.');
  const rest = segments.slice(last + 1).join('.');
  return { kind: 'set', collection, filter, update: { $set: { [set]: to } }, arrayFilters: [{ [rest ? `${MOVED}.${rest}` : MOVED]: from }] };
}

export function retargetedCluster(from: string, to: string): RecordRetarget[] {
  return (Object.entries(CLUSTER_FIELDS) as [MovedCollection, readonly string[]][])
    .flatMap(([collection, fields]) => fields.map((field) => retargetOf(collection, field, from, to)));
}

async function rekeyed(db: Db, retarget: Extract<RecordRetarget, { kind: 'rekey' }>): Promise<number> {
  const records = db.collection<{ _id: string }>(retarget.collection);
  const found = await records.findOne({ _id: retarget.from });
  if (!found) return 0;
  await records.insertOne({ ...found, _id: retarget.to });
  await records.deleteOne({ _id: retarget.from });
  return 1;
}

export async function retargetCluster(db: Db, from: string, to: string): Promise<number> {
  let moved = 0;
  for (const retarget of retargetedCluster(from, to)) {
    if (retarget.kind === 'rekey') {
      moved += await rekeyed(db, retarget);
      continue;
    }
    const done = await db.collection(retarget.collection).updateMany(retarget.filter, retarget.update, retarget.arrayFilters ? { arrayFilters: retarget.arrayFilters } : {});
    moved += done.modifiedCount;
  }
  return moved;
}

import { asStored } from '../../platform/testing/as-stored.js';
import type { ActionProposal, McpRequest } from '@koala/harness-types';
import type { PersonaRecord as EnginePersona, ToolDefinition as EngineTool, GrantKind, ToolGrant, WorkspaceDependency } from '@koala/agent-engine';
import type { RunEffort } from '@koala/agent-engine/procedure';
import type { FrontierClaim, FrontierUrl } from '../../platform/index.js';
import { collectionIn, copied, type Collections } from '../../platform/testing/memory-records.js';
import type { AuthoredExtension } from '../lib/authored-extensions.js';
import type { AutoModeSettings } from '../lib/auto-mode.js';
import type { Conversation, ConversationMessage } from '../lib/conversations.js';
import type { CorpusPage } from '../lib/corpus.js';
import type { ExtensionSettings } from '../lib/extension-settings.js';
import type { McpServerRecord } from '../lib/mcp-servers.js';
import type { McpToolHint } from '../lib/mcp-tool-hints.js';
import { PRINTS_KEPT, type PoisoningSignal, type ReadsPart, type RunReads, type SignalState } from '../lib/poisoning.js';
import { type ProcedureSource, procedureKey } from '../lib/procedure-source.js';
import type { PublishedWorkspace } from '../lib/published-workspace.js';
import type { Handover, RunGrant } from '../lib/run-grants.js';
import { type StoredNodeTrace, runTraceKey } from '../lib/run-traces.js';
import { MARK_MESSAGE_CHARS, type RunMark, type TurnLogEntry } from '../lib/turn-log.js';
import type { WorkspaceImageSpec } from '../lib/workspace-image-seeds.js';
import type { EngineStore, RunEnding } from '../store.js';

const stored = <T>(value: T): T => asStored(value) as T;

const rankOf = (value: unknown): number => {
  if (value === undefined || value === null) return 0;
  if (typeof value === 'number') return 1;
  if (typeof value === 'string') return 2;
  if (typeof value === 'boolean') return 4;
  if (value instanceof Date) return 5;
  return 3;
};

function compareValues(a: unknown, b: unknown): number {
  const ranks = rankOf(a) - rankOf(b);
  if (ranks !== 0) return ranks;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return Buffer.compare(Buffer.from(a), Buffer.from(b));
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  return 0;
}

type SortKey<T> = readonly [(row: T) => unknown, 1 | -1];

const sorted = <T>(rows: readonly T[], ...keys: readonly SortKey<T>[]): T[] =>
  [...rows].sort((a, b) => {
    for (const [field, direction] of keys) {
      const order = compareValues(field(a), field(b)) * direction;
      if (order !== 0) return order;
    }
    return 0;
  });

const withValues = (existing: readonly string[] | undefined, adding: readonly string[]): string[] => {
  const values = [...(existing ?? [])];
  for (const value of adding) if (!values.includes(value)) values.push(value);
  return values;
};

class Rows<T extends object> {
  constructor(private readonly rows: Map<string, T> = new Map<string, T>()) {}

  all(): T[] {
    return [...this.rows.values()].map(copied);
  }

  keyed(): Array<[string, T]> {
    return [...this.rows.entries()].map(([key, row]) => [key, copied(row)]);
  }

  get(key: string): T | undefined {
    const row = this.rows.get(key);
    return row ? copied(row) : undefined;
  }

  has(key: string): boolean {
    return this.rows.has(key);
  }

  put(key: string, row: T): void {
    this.rows.set(key, stored(row));
  }

  delete(key: string): boolean {
    return this.rows.delete(key);
  }

  deleteWhere(matches: (row: T) => boolean): number {
    let deleted = 0;
    for (const [key, row] of this.rows) {
      if (!matches(row)) continue;
      this.rows.delete(key);
      deleted += 1;
    }
    return deleted;
  }

  change(key: string, change: (row: T) => T): boolean {
    const row = this.rows.get(key);
    if (!row) return false;
    this.rows.set(key, stored(change(copied(row))));
    return true;
  }

  changeWhere(matches: (row: T) => boolean, change: (row: T) => T): number {
    let changed = 0;
    for (const [key, row] of this.rows) {
      if (!matches(row)) continue;
      this.rows.set(key, stored(change(copied(row))));
      changed += 1;
    }
    return changed;
  }
}

type StoredTurn = Omit<TurnLogEntry, 'at' | 'events'> & { at: Date; events: Array<Readonly<Record<string, unknown>>> };
type StoredReads = Omit<RunReads, 'key'>;

const toolGrantKey = (ownerId: string, agent: string, tool: string, kind?: GrantKind | undefined): string => (kind === 'server' ? `${ownerId}:${agent}:server:${tool}` : `${ownerId}:${agent}:${tool}`);
const kindMatches = (kind: GrantKind | undefined, grant: ToolGrant): boolean => (kind === 'server' ? grant.kind === 'server' : kind === 'tool' ? grant.kind !== 'server' : true);
const sharedOr = (ownerId: string | undefined, row: { ownerId?: string | undefined }): boolean => ownerId === undefined || row.ownerId === ownerId || !('ownerId' in row);
const turnOut = ({ at, ...rest }: StoredTurn): TurnLogEntry => ({ ...rest, at: at.toISOString() }) as unknown as TurnLogEntry;
const readsOut = (key: string, row: StoredReads): RunReads => ({ key, ...row });

export class MemoryEngineStore implements EngineStore {

  private readonly actionProposals: Rows<ActionProposal>;
  private readonly authoredExtensions: Rows<AuthoredExtension>;
  private readonly autoModeSettings: Rows<AutoModeSettings>;
  private readonly conversations: Rows<Conversation>;
  private readonly corpus: Rows<CorpusPage>;
  private readonly enginePersonas: Rows<EnginePersona>;
  private readonly engineTools: Rows<EngineTool>;
  private readonly extensionSettings: Rows<ExtensionSettings>;
  private readonly frontier: Rows<FrontierUrl>;
  private readonly mcpRequests: Rows<McpRequest>;
  private readonly mcpServers: Rows<McpServerRecord>;
  private readonly procedures: Rows<ProcedureSource>;
  private readonly publishedWorkspaces: Rows<PublishedWorkspace>;
  private readonly runEffort: Rows<RunEffort>;
  private readonly runGrants: Rows<RunGrant>;
  private readonly runEndings: Rows<RunEnding>;
  private readonly runReads: Rows<StoredReads>;
  private readonly poisoningSignals: Rows<PoisoningSignal>;
  private readonly runTraces: Rows<StoredNodeTrace>;
  private readonly toolGrants: Rows<ToolGrant>;
  private readonly turnLogs: Map<string, StoredTurn>;
  private readonly workspaceDependencies: Rows<WorkspaceDependency & { ownerId: string }>;
  private readonly workspaceImages: Rows<WorkspaceImageSpec>;

  constructor(collections: Collections = new Map()) {
    this.conversations = new Rows(collectionIn<Conversation>(collections, 'conversations'));
    this.actionProposals = new Rows(collectionIn<ActionProposal>(collections, 'actionProposals'));
    this.authoredExtensions = new Rows(collectionIn<AuthoredExtension>(collections, 'authoredExtensions'));
    this.autoModeSettings = new Rows(collectionIn<AutoModeSettings>(collections, 'autoModeSettings'));
    this.corpus = new Rows(collectionIn<CorpusPage>(collections, 'corpus'));
    this.enginePersonas = new Rows(collectionIn<EnginePersona>(collections, 'enginePersonas'));
    this.engineTools = new Rows(collectionIn<EngineTool>(collections, 'engineTools'));
    this.extensionSettings = new Rows(collectionIn<ExtensionSettings>(collections, 'extensionSettings'));
    this.frontier = new Rows(collectionIn<FrontierUrl>(collections, 'crawl_frontier'));
    this.mcpRequests = new Rows(collectionIn<McpRequest>(collections, 'mcpRequests'));
    this.mcpServers = new Rows(collectionIn<McpServerRecord>(collections, 'mcpServers'));
    this.procedures = new Rows(collectionIn<ProcedureSource>(collections, 'procedures'));
    this.publishedWorkspaces = new Rows(collectionIn<PublishedWorkspace>(collections, 'publishedWorkspaces'));
    this.runEffort = new Rows(collectionIn<RunEffort>(collections, 'engineRunEffort'));
    this.runGrants = new Rows(collectionIn<RunGrant>(collections, 'runGrants'));
    this.runEndings = new Rows(collectionIn<RunEnding>(collections, 'runEndings'));
    this.runReads = new Rows(collectionIn<StoredReads>(collections, 'runReads'));
    this.poisoningSignals = new Rows(collectionIn<PoisoningSignal>(collections, 'poisoningSignals'));
    this.runTraces = new Rows(collectionIn<StoredNodeTrace>(collections, 'engineRunTraces'));
    this.toolGrants = new Rows(collectionIn<ToolGrant>(collections, 'toolGrants'));
    this.workspaceDependencies = new Rows(collectionIn<WorkspaceDependency & { ownerId: string }>(collections, 'workspaceDependencies'));
    this.workspaceImages = new Rows(collectionIn<WorkspaceImageSpec>(collections, 'workspaceImages'));
    this.turnLogs = collectionIn<StoredTurn>(collections, 'turnLogs');
  }

  private get turnRows(): StoredTurn[] {
    return [...this.turnLogs.values()];
  }

  async ensureIndexes(): Promise<void> {}

  async saveRunGrant(grant: RunGrant): Promise<void> {
    this.runGrants.put(grant.id, grant);
  }

  async getRunGrant(id: string): Promise<RunGrant | undefined> {
    return this.runGrants.get(id);
  }

  async getRunGrantOfRun(runId: string): Promise<RunGrant | undefined> {
    return this.runGrants.all().find((grant) => grant.runId === runId);
  }

  async getLiveRunGrants(personId: string): Promise<RunGrant[]> {
    return this.runGrants.all().filter((grant) => grant.personId === personId && grant.state === 'live');
  }

  async openRunReads(key: string, ownerId: string, runId: string, fpKey: string, at: string): Promise<RunReads> {
    const existing = this.runReads.get(key);
    const opened: StoredReads = existing
      ? { ...existing, runs: withValues(existing.runs, [runId]), lastReadAt: at }
      : { ownerId, fpKey, classes: [], private: [], outside: [], hosts: [], runs: [runId], lastReadAt: at };
    this.runReads.put(key, opened);
    return readsOut(key, copied(opened));
  }

  async addRunReads(key: string, part: ReadsPart, at: string): Promise<void> {
    if (!part.classes.length && !part.private.length && !part.outside.length && !part.hosts.length && !part.readRuns?.length) return;
    this.runReads.change(key, (reads) => ({
      ...reads,
      classes: withValues(reads.classes, part.classes) as RunReads['classes'],
      hosts: withValues(reads.hosts, part.hosts),
      readRuns: withValues(reads.readRuns, part.readRuns ?? []),
      private: [...(reads.private ?? []), ...part.private].slice(-PRINTS_KEPT),
      outside: [...(reads.outside ?? []), ...part.outside].slice(-PRINTS_KEPT),
      lastReadAt: at,
    }));
  }

  async getRunReadsOfRuns(runIds: readonly string[]): Promise<RunReads[]> {
    if (!runIds.length) return [];
    return this.runReads.keyed().filter(([, reads]) => reads.runs.some((run) => runIds.includes(run))).map(([key, reads]) => readsOut(key, reads));
  }

  async savePoisoningSignal(signal: PoisoningSignal): Promise<boolean> {
    if (this.poisoningSignals.has(signal.id)) return false;
    this.poisoningSignals.put(signal.id, signal);
    return true;
  }

  async getPoisoningSignals(ownerId: string, filter: { state?: SignalState | undefined; runIds?: readonly string[] | undefined } = {}): Promise<PoisoningSignal[]> {
    const { state, runIds } = filter;
    const found = this.poisoningSignals.all().filter((signal) => signal.ownerId === ownerId && (!state || signal.state === state) && (!runIds || runIds.includes(signal.runId)));
    return sorted(found, [(signal) => signal.at, -1]);
  }

  async getPoisoningSignal(ownerId: string, id: string): Promise<PoisoningSignal | undefined> {
    const signal = this.poisoningSignals.get(id);
    return signal?.ownerId === ownerId ? signal : undefined;
  }

  async setPoisoningSignalState(ownerId: string, id: string, state: SignalState, because?: string | undefined): Promise<boolean> {
    if (this.poisoningSignals.get(id)?.ownerId !== ownerId) return false;
    return this.poisoningSignals.change(id, (signal) => ({ ...signal, state, ...(because ? { dismissedBecause: because } : {}) }));
  }

  async getUntoldPoisoningSignals(): Promise<PoisoningSignal[]> {
    return sorted(this.poisoningSignals.all().filter((signal) => !('toldAt' in signal)), [(signal) => signal.at, 1]);
  }

  async markPoisoningSignalTold(id: string, at: string): Promise<void> {
    this.poisoningSignals.change(id, (signal) => ({ ...signal, toldAt: at }));
  }

  async saveRunEnded(ending: RunEnding): Promise<void> {
    const { runId, ownerId, ...rest } = ending;
    this.runEndings.put(runId, stored({ ...(this.runEndings.get(runId) ?? {}), runId, ownerId, ...rest }));
  }

  async saveRunHandover(ownerId: string, runId: string, handover: Handover): Promise<void> {
    this.runEndings.put(runId, { ...(this.runEndings.get(runId) ?? {}), runId, ownerId, handover });
  }

  async getRunEndings(ownerId: string, runIds: readonly string[]): Promise<RunEnding[]> {
    if (runIds.length === 0) return [];
    return this.runEndings.all().filter((ending) => ending.ownerId === ownerId && runIds.includes(ending.runId));
  }

  async getCorpusPages(filter: { ownerId: string; ingestId?: string; projectId?: string }): Promise<CorpusPage[]> {
    return this.corpus.all().filter((page) => page.ownerId === filter.ownerId && (!filter.ingestId || page.ingestId === filter.ingestId) && (!filter.projectId || page.projectId === filter.projectId));
  }

  async saveCorpusPages(pages: CorpusPage[]): Promise<void> {
    for (const page of pages) this.corpus.put(page.id, page);
  }

  async deleteCorpus(ingestId: string): Promise<void> {
    this.corpus.deleteWhere((page) => page.ingestId === ingestId);
  }

  async enqueueFrontier(urls: FrontierUrl[]): Promise<number> {
    let inserted = 0;
    for (const url of urls) {
      if (this.frontier.has(url.id)) continue;
      this.frontier.put(url.id, url);
      inserted += 1;
    }
    return inserted;
  }

  async claimFrontier(ingestId: string, limit: number): Promise<FrontierClaim[]> {
    if (limit <= 0) return [];
    const pending = this.frontier.all().filter((url) => url.ingestId === ingestId && url.state === 'pending');
    return sorted(pending, [(url) => url.depth, 1], [(url) => url.rank, -1], [(url) => url.url, 1])
      .slice(0, limit)
      .map((url) => ({ url: String(url.url), depth: Number(url.depth) }));
  }

  async completeFrontier(ingestId: string, urls: string[]): Promise<void> {
    if (!urls.length) return;
    this.frontier.changeWhere((url) => url.ingestId === ingestId && urls.includes(url.url), (url) => ({ ...url, state: 'done' }));
  }

  async countFrontier(ingestId: string): Promise<number> {
    return this.frontier.all().filter((url) => url.ingestId === ingestId && url.state === 'pending').length;
  }

  async deleteFrontier(ingestId: string): Promise<void> {
    this.frontier.deleteWhere((url) => url.ingestId === ingestId);
  }

  async getConversations(): Promise<Conversation[]> {
    return this.conversations.all();
  }

  async getConversation(ownerId: string, id: string): Promise<Conversation | undefined> {
    const conversation = this.conversations.get(id);
    return conversation?.ownerId === ownerId ? conversation : undefined;
  }

  private changeOwnConversation(ownerId: string, id: string, change: (conversation: Conversation) => Conversation): boolean {
    if (this.conversations.get(id)?.ownerId !== ownerId) return false;
    return this.conversations.change(id, change);
  }

  async allowToolInConversation(ownerId: string, conversationId: string, tool: string): Promise<boolean> {
    return this.changeOwnConversation(ownerId, conversationId, (conversation) => ({ ...conversation, allowedTools: withValues(conversation.allowedTools, [tool]) }));
  }

  async setConversationAutoMode(ownerId: string, conversationId: string, on: boolean): Promise<boolean> {
    return this.changeOwnConversation(ownerId, conversationId, (conversation) => {
      if (on) return { ...conversation, autoMode: true };
      const { autoMode: _off, ...rest } = conversation;
      return rest;
    });
  }

  async bindConversation(ownerId: string, conversationId: string, binding: { treeId: string; projectId?: string | undefined }, _tx?: unknown): Promise<boolean> {
    const conversation = this.conversations.get(conversationId);
    if (!conversation || conversation.ownerId !== ownerId || 'treeId' in conversation) return false;
    const set = { treeId: binding.treeId, ...(binding.projectId ? { projectId: binding.projectId } : {}), updatedAt: new Date().toISOString() };
    return this.conversations.change(conversationId, (current) => ({ ...current, ...set }));
  }

  async appendMessage(ownerId: string, conversationId: string, message: ConversationMessage): Promise<boolean> {
    return this.changeOwnConversation(ownerId, conversationId, (conversation) => ({ ...conversation, messages: [...(conversation.messages ?? []), message], updatedAt: message.at }));
  }

  async appendNotice(ownerId: string, conversationId: string, message: ConversationMessage): Promise<boolean> {
    const { notice } = message;
    if (!notice) return false;
    const conversation = this.conversations.get(conversationId);
    if (!conversation || conversation.ownerId !== ownerId) return false;
    if ((conversation.messages ?? []).some((said) => said.notice?.key === notice.key)) return false;
    return this.conversations.change(conversationId, (current) => ({ ...current, messages: [...(current.messages ?? []), message], updatedAt: message.at }));
  }

  async ownsRun(ownerId: string, runId: string): Promise<boolean> {
    return this.turnRows.some((entry) => entry.ownerId === ownerId && (entry.turnId === runId || (entry.events ?? []).some((event) => event.runId === runId)));
  }

  async runOrigin(ownerId: string, runId: string): Promise<{ agentId?: string | undefined; turnId: string } | undefined> {
    const started = (event: Readonly<Record<string, unknown>>): boolean => event.runId === runId && event.type === 'run.started';
    const found = this.turnRows.find((entry) => entry.ownerId === ownerId && (entry.events ?? []).some(started));
    if (!found?.turnId) return undefined;
    const agentId = found.events.find(started)?.agentId;
    return { turnId: found.turnId, ...(agentId ? { agentId: agentId as string } : {}) };
  }

  async saveConversation(conversation: Conversation): Promise<void> {
    const existing = this.conversations.get(conversation.id);
    if (existing && existing.ownerId !== conversation.ownerId) throw new Error('You have no conversation with that id.');
    this.conversations.put(conversation.id, conversation);
  }

  async deleteConversation(id: string): Promise<void> {
    this.conversations.delete(id);
  }

  async getWorkspaceImages(ownerId?: string): Promise<WorkspaceImageSpec[]> {
    return this.workspaceImages.all().filter((image) => !ownerId || image.ownerId === ownerId || !('ownerId' in image));
  }

  async saveWorkspaceImage(image: WorkspaceImageSpec): Promise<void> {
    const { _id: _ignored, ...doc } = image as WorkspaceImageSpec & { _id?: unknown };
    this.workspaceImages.put(`${image.ownerId}:${image.id}`, doc);
  }

  async findRunEffort(runId: string): Promise<RunEffort | undefined> {
    return this.runEffort.get(runId);
  }

  async reownRuns(from: string, to: string, runIds?: readonly string[] | undefined): Promise<number> {
    if (runIds && runIds.length === 0) return 0;
    const named = (id: string): boolean => !runIds || runIds.includes(id);
    const moving = <T extends { ownerId?: string | undefined }>(rows: Rows<T>, runOf: (row: T) => string): number =>
      rows.changeWhere((row) => row.ownerId === from && row.ownerId !== to && named(runOf(row)), (row) => ({ ...row, ownerId: to }));
    let turns = 0;
    for (const entry of this.turnRows) {
      if (entry.ownerId !== from || entry.ownerId === to || !named(entry.turnId)) continue;
      entry.ownerId = to;
      turns += 1;
    }
    return turns
      + moving(this.runTraces, (trace) => trace.runId)
      + moving(this.runEffort, (effort) => effort.runId)
      + moving(this.runEndings, (ending) => ending.runId)
      + moving(this.runGrants, (grant) => grant.runId)
      + moving(this.poisoningSignals, (signal) => signal.runId);
  }

  async getMcpToolHints(_ownerId: string): Promise<McpToolHint[]> {
    return [];
  }

  async deleteMcpToolHint(_ownerId: string, _server: string, _tool: string): Promise<void> {}

  async getMcpRequests(ownerId: string, conversationId?: string): Promise<McpRequest[]> {
    const found = this.mcpRequests.all().filter((request) => request.ownerId === ownerId && (conversationId === undefined || request.conversationId === conversationId));
    return sorted(found, [(request) => request.createdAt, 1]);
  }

  async getMcpRequest(ownerId: string, id: string): Promise<McpRequest | undefined> {
    const request = this.mcpRequests.get(id);
    return request?.ownerId === ownerId ? request : undefined;
  }

  async getActionProposals(ownerId: string, filter: { conversationId?: string | undefined; treeId?: string | undefined } = {}): Promise<ActionProposal[]> {
    const found = this.actionProposals.all().filter((proposal) =>
      proposal.ownerId === ownerId
      && (filter.conversationId === undefined || proposal.conversationId === filter.conversationId)
      && (filter.treeId === undefined || proposal.treeId === filter.treeId));
    return sorted(found, [(proposal) => proposal.createdAt, 1]);
  }

  async getActionProposal(ownerId: string, id: string): Promise<ActionProposal | undefined> {
    const proposal = this.actionProposals.get(id);
    return proposal?.ownerId === ownerId ? proposal : undefined;
  }

  async saveActionProposal(proposal: ActionProposal): Promise<void> {
    this.actionProposals.put(proposal.id, proposal);
  }

  async getExtensionSettings(ownerId: string): Promise<ExtensionSettings | undefined> {
    const settings = this.extensionSettings.get(ownerId);
    return settings ? { ...settings, ownerId } : undefined;
  }

  async getAuthoredExtensions(ownerId: string): Promise<AuthoredExtension[]> {
    return this.authoredExtensions.all().filter((extension) => extension.ownerId === ownerId);
  }

  async saveAuthoredExtension(extension: AuthoredExtension): Promise<void> {
    this.authoredExtensions.put(`${extension.ownerId}:${extension.id}`, extension);
  }

  async deleteAuthoredExtension(ownerId: string, id: string): Promise<void> {
    this.authoredExtensions.delete(`${ownerId}:${id}`);
  }

  async saveExtensionSettings(settings: ExtensionSettings): Promise<void> {
    this.extensionSettings.put(settings.ownerId, settings);
  }

  async getAutoModeSettings(ownerId: string): Promise<AutoModeSettings | undefined> {
    const settings = this.autoModeSettings.get(ownerId);
    return settings ? { ...settings, ownerId } : undefined;
  }

  async saveAutoModeSettings(settings: AutoModeSettings): Promise<void> {
    this.autoModeSettings.put(settings.ownerId, settings);
  }

  async saveMcpRequest(request: McpRequest): Promise<void> {
    this.mcpRequests.put(request.id, request);
  }

  async getProcedure(ownerId: string, id: string): Promise<ProcedureSource | undefined> {
    return this.procedures.get(procedureKey(ownerId, id));
  }

  async getProcedures(ownerId?: string): Promise<ProcedureSource[]> {
    return this.procedures.all().filter((source) => sharedOr(ownerId, source));
  }

  async saveProcedure(source: ProcedureSource): Promise<void> {
    this.procedures.put(procedureKey(source.ownerId, source.id), source);
  }

  async saveRunTraces(traces: StoredNodeTrace[]): Promise<void> {
    for (const trace of traces) this.runTraces.put(runTraceKey(trace.runId, trace.sequence), trace);
  }

  async saveRunEffort(effort: RunEffort): Promise<void> {
    this.runEffort.put(effort.runId, effort);
  }

  async getRunEffort(ownerId: string, procedureId: string, modelKey?: string): Promise<RunEffort[]> {
    const found = this.runEffort.all().filter((effort) => effort.ownerId === ownerId && effort.procedureId === procedureId && (!modelKey || effort.modelKey === modelKey));
    return sorted(found, [(effort) => effort.finishedAt, -1]).slice(0, 500);
  }

  async appendTurnLog(entry: TurnLogEntry): Promise<void> {
    if (this.turnRows.some((logged) => logged.turnId === entry.turnId && logged.seq === entry.seq)) {
      throw new Error(`E11000 duplicate key error collection: turnLogs index: turnId_1_seq_1 dup key: { turnId: "${entry.turnId}", seq: ${entry.seq} }`);
    }
    this.turnLogs.set(`${entry.turnId}:${entry.seq}`, stored({ ...entry, at: new Date(entry.at) }) as unknown as StoredTurn);
  }

  async getTurnLog(ownerId: string, turnId: string, after: number): Promise<TurnLogEntry[]> {
    const found = this.turnRows.filter((entry) => entry.ownerId === ownerId && entry.turnId === turnId && entry.seq > after);
    return sorted(found, [(entry) => entry.seq, 1]).map((entry) => turnOut(copied(entry)));
  }

  async getTurnLogMarks(ownerId: string, turnId: string, types: readonly string[]): Promise<RunMark[]> {
    const entries = sorted(this.turnRows.filter((entry) => entry.ownerId === ownerId && entry.turnId === turnId), [(entry) => entry.seq, 1]);
    const marks: RunMark[] = [];
    for (const entry of entries) {
      for (const event of entry.events ?? []) {
        if (typeof event.type !== 'string' || !types.includes(event.type)) continue;
        const mark: Record<string, unknown> = { type: event.type };
        if ('runId' in event) mark.runId = event.runId;
        for (const field of ['parentRunId', 'agentId', 'callId', 'tool', 'level']) {
          const value = event[field];
          if (value !== undefined && value !== null) mark[field] = copied(value);
        }
        if (typeof event.message === 'string') mark.message = Array.from(event.message).slice(0, MARK_MESSAGE_CHARS).join('');
        marks.push(mark as unknown as RunMark);
      }
    }
    return marks;
  }

  async recentTurns(ownerId: string, since: string, limit: number): Promise<TurnLogEntry[]> {
    const from = new Date(since).getTime();
    const found = sorted(this.turnRows.filter((entry) => entry.ownerId === ownerId && entry.seq === 1 && entry.at.getTime() >= from), [(entry) => entry.at, -1]);
    return (limit === 0 ? found : found.slice(0, Math.abs(limit))).map((entry) => turnOut(copied(entry)));
  }

  async lastTurnLogSeq(turnId: string): Promise<number> {
    const [last] = sorted(this.turnRows.filter((entry) => entry.turnId === turnId), [(entry) => entry.seq, -1]);
    return last?.seq ?? 0;
  }

  async getRunTraces(ownerId: string, runId: string): Promise<StoredNodeTrace[]> {
    return sorted(this.runTraces.all().filter((trace) => trace.ownerId === ownerId && trace.runId === runId), [(trace) => trace.sequence, 1]);
  }

  async deleteProcedure(ownerId: string | undefined, id: string): Promise<void> {
    this.procedures.delete(procedureKey(ownerId, id));
  }

  async getEnginePersonas(ownerId?: string): Promise<EnginePersona[]> {
    return this.enginePersonas.all().filter((persona) => sharedOr(ownerId, persona));
  }

  async getEngineTools(ownerId?: string): Promise<EngineTool[]> {
    return this.engineTools.all().filter((tool) => sharedOr(ownerId, tool));
  }

  async saveEngineTool(tool: EngineTool): Promise<void> {
    this.engineTools.put(`${tool.ownerId ?? 'builtin'}:${tool.name}`, tool);
  }

  async deleteEngineTool(ownerId: string | undefined, name: string): Promise<void> {
    this.engineTools.delete(`${ownerId ?? 'builtin'}:${name}`);
  }

  async saveEnginePersona(persona: EnginePersona): Promise<void> {
    this.enginePersonas.put(`${persona.ownerId ?? 'builtin'}:${persona.slug}`, persona);
  }

  async deleteEnginePersona(ownerId: string | undefined, slug: string): Promise<void> {
    this.enginePersonas.delete(`${ownerId ?? 'builtin'}:${slug}`);
  }

  async getPublishedWorkspace(ownerId: string, treeId: string): Promise<PublishedWorkspace | undefined> {
    return this.publishedWorkspaces.get(`${ownerId}:${treeId}`);
  }

  async savePublishedWorkspace(workspace: PublishedWorkspace): Promise<void> {
    this.publishedWorkspaces.put(`${workspace.ownerId}:${workspace.treeId}`, workspace);
  }

  async getPublishedWorkspaces(ownerId: string): Promise<PublishedWorkspace[]> {
    return this.publishedWorkspaces.all().filter((workspace) => workspace.ownerId === ownerId);
  }

  async deletePublishedWorkspace(ownerId: string, treeId: string): Promise<void> {
    this.publishedWorkspaces.delete(`${ownerId}:${treeId}`);
  }

  async getMcpServers(ownerId: string): Promise<McpServerRecord[]> {
    return sorted(this.mcpServers.all().filter((server) => server.ownerId === ownerId), [(server) => server.name, 1]);
  }

  async saveMcpServer(server: McpServerRecord): Promise<void> {
    this.mcpServers.put(`${server.ownerId}:${server.id}`, server);
  }

  async deleteMcpServer(ownerId: string, id: string): Promise<void> {
    this.mcpServers.delete(`${ownerId}:${id}`);
  }

  async getWorkspaceDependencies(ownerId: string): Promise<WorkspaceDependency[]> {
    return sorted(this.workspaceDependencies.all().filter((dependency) => dependency.ownerId === ownerId), [(dependency) => dependency.name, 1]);
  }

  async saveWorkspaceDependency(dependency: WorkspaceDependency & { ownerId: string }): Promise<void> {
    this.workspaceDependencies.put(`${dependency.ownerId}:${dependency.name}`, dependency);
  }

  async deleteWorkspaceDependency(ownerId: string, name: string): Promise<void> {
    this.workspaceDependencies.delete(`${ownerId}:${name}`);
  }

  async getToolGrants(ownerId: string): Promise<ToolGrant[]> {
    const own = this.toolGrants.keyed().filter(([, grant]) => grant.ownerId === ownerId);
    return sorted(own, [([, grant]) => grant.grantedAt, 1], [([key]) => key, 1]).map(([, grant]) => grant);
  }

  async saveToolGrant(grant: ToolGrant & { ownerId: string }): Promise<void> {
    this.toolGrants.put(toolGrantKey(grant.ownerId, grant.agent, grant.tool, grant.kind), grant);
  }

  async deleteToolGrant(ownerId: string, agent: string, tool: string, kind?: GrantKind | undefined): Promise<void> {
    this.toolGrants.delete(toolGrantKey(ownerId, agent, tool, kind));
  }

  async deleteToolGrantsFor(ownerId: string | undefined, of: { agent?: string; tool?: string; kind?: GrantKind | undefined }): Promise<number> {
    return this.toolGrants.deleteWhere((grant) =>
      (ownerId === undefined || grant.ownerId === ownerId)
      && (!of.agent || grant.agent === of.agent)
      && (!of.tool || grant.tool === of.tool)
      && kindMatches(of.kind, grant));
  }
}

import type { ActionProposal, McpRequest } from '@koala/harness-types';
import { type AreaStore, fromDoc, toDoc } from '../platform/lib/collection.js';
import type { AuthoredExtension } from './lib/authored-extensions.js';
import type { AutoModeSettings } from './lib/auto-mode.js';
import type { Collection, Db } from 'mongodb';
import type { Conversation, ConversationMessage } from './lib/conversations.js';
import type { CorpusPage } from './lib/corpus.js';
import type { PersonaRecord as EnginePersona, ToolDefinition as EngineTool, GrantKind, ToolGrant, WorkspaceDependency } from '@koala/agent-engine';
import type { ExtensionSettings } from './lib/extension-settings.js';
import type { FrontierClaim, FrontierUrl } from '../platform/index.js';
import { MARK_MESSAGE_CHARS, type RunMark, TURN_LOG_RETENTION_SECONDS, type TurnLogEntry } from './lib/turn-log.js';
import type { McpServerRecord } from './lib/mcp-servers.js';
import { type McpToolHint, hintKey } from './lib/mcp-tool-hints.js';
import { type ProcedureSource, procedureKey } from './lib/procedure-source.js';
import type { PublishedWorkspace } from './lib/published-workspace.js';
import type { RunEffort } from '@koala/agent-engine/procedure';
import { type StoredNodeTrace, runTraceKey } from './lib/run-traces.js';
import type { WorkspaceImageSpec } from './lib/workspace-image-seeds.js';

export interface EngineStore extends AreaStore {
  findRunEffort(runId: string): Promise<RunEffort | undefined>;
  reownRuns(from: string, to: string, runIds?: readonly string[] | undefined): Promise<number>;
  getWorkspaceImages(ownerId?: string): Promise<WorkspaceImageSpec[]>;
  saveWorkspaceImage(image: WorkspaceImageSpec): Promise<void>;
  getCorpusPages(filter: { ownerId: string; ingestId?: string; projectId?: string }): Promise<CorpusPage[]>;
  saveCorpusPages(pages: CorpusPage[]): Promise<void>;
  deleteCorpus(ingestId: string): Promise<void>;
  enqueueFrontier(urls: FrontierUrl[]): Promise<number>;
  claimFrontier(ingestId: string, limit: number): Promise<FrontierClaim[]>;
  completeFrontier(ingestId: string, urls: string[]): Promise<void>;
  countFrontier(ingestId: string): Promise<number>;
  deleteFrontier(ingestId: string): Promise<void>;
  getConversations(): Promise<Conversation[]>;
  getConversation(ownerId: string, id: string): Promise<Conversation | undefined>;
  allowToolInConversation(ownerId: string, conversationId: string, tool: string): Promise<boolean>;
  setConversationAutoMode(ownerId: string, conversationId: string, on: boolean): Promise<boolean>;
  bindConversation(ownerId: string, conversationId: string, binding: { treeId: string; projectId?: string | undefined }): Promise<boolean>;
  appendNotice(ownerId: string, conversationId: string, message: ConversationMessage): Promise<boolean>;
  appendMessage(ownerId: string, conversationId: string, message: ConversationMessage): Promise<boolean>;
  ownsRun(ownerId: string, runId: string): Promise<boolean>;
  runOrigin(ownerId: string, runId: string): Promise<{ agentId?: string | undefined; turnId: string } | undefined>;
  saveConversation(conversation: Conversation): Promise<void>;
  deleteConversation(id: string): Promise<void>;
  getMcpRequests(ownerId: string, conversationId?: string): Promise<McpRequest[]>;
  getMcpRequest(ownerId: string, id: string): Promise<McpRequest | undefined>;
  saveMcpRequest(request: McpRequest): Promise<void>;
  getMcpToolHints(ownerId: string): Promise<McpToolHint[]>;
  deleteMcpToolHint(ownerId: string, server: string, tool: string): Promise<void>;
  getActionProposals(ownerId: string, filter?: { conversationId?: string | undefined; treeId?: string | undefined }): Promise<ActionProposal[]>;
  getActionProposal(ownerId: string, id: string): Promise<ActionProposal | undefined>;
  saveActionProposal(proposal: ActionProposal): Promise<void>;
  getExtensionSettings(ownerId: string): Promise<ExtensionSettings | undefined>;
  getAuthoredExtensions(ownerId: string): Promise<AuthoredExtension[]>;
  saveAuthoredExtension(extension: AuthoredExtension): Promise<void>;
  deleteAuthoredExtension(ownerId: string, id: string): Promise<void>;
  saveExtensionSettings(settings: ExtensionSettings): Promise<void>;
  getAutoModeSettings(ownerId: string): Promise<AutoModeSettings | undefined>;
  saveAutoModeSettings(settings: AutoModeSettings): Promise<void>;
  getProcedure(ownerId: string, id: string): Promise<ProcedureSource | undefined>;
  getProcedures(ownerId?: string): Promise<ProcedureSource[]>;
  saveProcedure(source: ProcedureSource): Promise<void>;
  deleteProcedure(ownerId: string | undefined, id: string): Promise<void>;
  saveRunTraces(traces: StoredNodeTrace[]): Promise<void>;
  getRunTraces(ownerId: string, runId: string): Promise<StoredNodeTrace[]>;
  appendTurnLog(entry: TurnLogEntry): Promise<void>;
  getTurnLog(ownerId: string, turnId: string, after: number): Promise<TurnLogEntry[]>;
  getTurnLogMarks(ownerId: string, turnId: string, types: readonly string[]): Promise<RunMark[]>;
  lastTurnLogSeq(turnId: string): Promise<number>;
  recentTurns(ownerId: string, since: string, limit: number): Promise<TurnLogEntry[]>;
  saveRunEffort(effort: RunEffort): Promise<void>;
  getRunEffort(ownerId: string, procedureId: string, modelKey?: string): Promise<RunEffort[]>;
  getEnginePersonas(ownerId?: string): Promise<EnginePersona[]>;
  saveEnginePersona(persona: EnginePersona): Promise<void>;
  deleteEnginePersona(ownerId: string | undefined, slug: string): Promise<void>;
  getPublishedWorkspace(ownerId: string, treeId: string): Promise<PublishedWorkspace | undefined>;
  getPublishedWorkspaces(ownerId: string): Promise<PublishedWorkspace[]>;
  savePublishedWorkspace(workspace: PublishedWorkspace): Promise<void>;
  deletePublishedWorkspace(ownerId: string, treeId: string): Promise<void>;
  getMcpServers(ownerId: string): Promise<McpServerRecord[]>;
  saveMcpServer(server: McpServerRecord): Promise<void>;
  deleteMcpServer(ownerId: string, id: string): Promise<void>;
  getWorkspaceDependencies(ownerId: string): Promise<WorkspaceDependency[]>;
  saveWorkspaceDependency(dependency: WorkspaceDependency & { ownerId: string }): Promise<void>;
  deleteWorkspaceDependency(ownerId: string, name: string): Promise<void>;
  getToolGrants(ownerId: string): Promise<ToolGrant[]>;
  saveToolGrant(grant: ToolGrant & { ownerId: string }): Promise<void>;
  deleteToolGrant(ownerId: string, agent: string, tool: string, kind?: GrantKind | undefined): Promise<void>;
  deleteToolGrantsFor(ownerId: string | undefined, of: { agent?: string; tool?: string; kind?: GrantKind | undefined }): Promise<number>;
  getEngineTools(ownerId?: string): Promise<EngineTool[]>;
  saveEngineTool(tool: EngineTool): Promise<void>;
  deleteEngineTool(ownerId: string | undefined, name: string): Promise<void>;
}

const toolGrantKey = (ownerId: string, agent: string, tool: string, kind?: GrantKind | undefined): string => (kind === 'server' ? `${ownerId}:${agent}:server:${tool}` : `${ownerId}:${agent}:${tool}`);
const kindFilter = (kind: GrantKind | undefined): Record<string, unknown> => (kind === 'server' ? { kind: 'server' } : kind === 'tool' ? { kind: { $ne: 'server' } } : {});

export class MongoEngineStore implements EngineStore {
  constructor(private readonly db: () => Db) {}

  private get actionProposals(): Collection {
    return this.db().collection('actionProposals');
  }

  private get artifactChunks(): Collection {
    return this.db().collection('artifactChunks');
  }

  private get artifacts(): Collection {
    return this.db().collection('artifacts');
  }

  private get authoredExtensions(): Collection {
    return this.db().collection('authoredExtensions');
  }

  private get autoModeSettings(): Collection {
    return this.db().collection('autoModeSettings');
  }

  private get conversations(): Collection {
    return this.db().collection('conversations');
  }

  private get corpus(): Collection {
    return this.db().collection('corpus');
  }

  private get enginePersonas(): Collection {
    return this.db().collection('enginePersonas');
  }

  private get engineTools(): Collection {
    return this.db().collection('engineTools');
  }

  private get extensionSettings(): Collection {
    return this.db().collection('extensionSettings');
  }

  private get frontier(): Collection {
    return this.db().collection('crawl_frontier');
  }

  private get mcpRequests(): Collection {
    return this.db().collection('mcpRequests');
  }

  private get mcpServers(): Collection {
    return this.db().collection('mcpServers');
  }

  private get mcpToolHints(): Collection {
    return this.db().collection('mcpToolHints');
  }

  private get procedures(): Collection {
    return this.db().collection('procedures');
  }

  private get publishedWorkspaces(): Collection {
    return this.db().collection('publishedWorkspaces');
  }

  private get runEffort(): Collection {
    return this.db().collection('engineRunEffort');
  }

  private get runTraces(): Collection {
    return this.db().collection('engineRunTraces');
  }

  private get toolGrants(): Collection {
    return this.db().collection('toolGrants');
  }

  private get turnLogs(): Collection {
    return this.db().collection('turnLogs');
  }

  private get workspaceDependencies(): Collection {
    return this.db().collection('workspaceDependencies');
  }

  private get workspaceImages(): Collection {
    return this.db().collection('workspaceImages');
  }

  async ensureIndexes(): Promise<void> {
    await this.runTraces.createIndex({ ownerId: 1, runId: 1, sequence: 1 });
    await this.turnLogs.createIndex({ turnId: 1, seq: 1 }, { unique: true });
    await this.turnLogs.createIndex({ at: 1 }, { expireAfterSeconds: TURN_LOG_RETENTION_SECONDS });
    await this.turnLogs.createIndex({ ownerId: 1, seq: 1, at: -1 });
    await this.toolGrants.createIndex({ ownerId: 1, agent: 1 });
    await this.runEffort.createIndex({ ownerId: 1, procedureId: 1, modelKey: 1, finishedAt: -1 });
    await this.frontier.createIndex({ ingestId: 1, state: 1, depth: 1, rank: -1, url: 1 });
    await this.corpus.createIndex({ ownerId: 1, ingestId: 1 });
    await this.corpus.createIndex({ ownerId: 1, projectId: 1 });
  }

  async getCorpusPages(filter: { ownerId: string; ingestId?: string; projectId?: string }): Promise<CorpusPage[]> {
    const query: Record<string, unknown> = { ownerId: filter.ownerId };
    if (filter.ingestId) query.ingestId = filter.ingestId;
    if (filter.projectId) query.projectId = filter.projectId;
    return (await this.corpus.find(query).toArray()).map(doc => fromDoc<CorpusPage>(doc));
  }

  async saveCorpusPages(pages: CorpusPage[]): Promise<void> {
    if (!pages.length) return;
    await this.corpus.bulkWrite(pages.map((page) => {
      const doc = toDoc(page);
      const { _id, ...rest } = doc;
      return { replaceOne: { filter: { _id }, replacement: rest, upsert: true } };
    }));
  }

  async deleteCorpus(ingestId: string): Promise<void> {
    await this.corpus.deleteMany({ ingestId });
  }

  async enqueueFrontier(urls: FrontierUrl[]): Promise<number> {
    if (!urls.length) return 0;
    try {
      const res = await this.frontier.insertMany(
        urls.map((u) => { const { _id, ...rest } = toDoc(u); return { _id, ...rest }; }),
        { ordered: false },
      );
      return res.insertedCount;
    } catch (err: any) {
      if (err?.code === 11000 || err?.writeErrors) return err.result?.insertedCount ?? err.insertedCount ?? 0;
      throw err;
    }
  }

  async claimFrontier(ingestId: string, limit: number): Promise<FrontierClaim[]> {
    if (limit <= 0) return [];
    const docs = await this.frontier
      .find({ ingestId, state: 'pending' })
      .sort({ depth: 1, rank: -1, url: 1 })
      .limit(limit)
      .toArray();
    return docs.map((d) => ({ url: String(d.url), depth: Number(d.depth) }));
  }

  async completeFrontier(ingestId: string, urls: string[]): Promise<void> {
    if (!urls.length) return;
    await this.frontier.updateMany({ ingestId, url: { $in: urls } }, { $set: { state: 'done' } });
  }

  async countFrontier(ingestId: string): Promise<number> {
    return this.frontier.countDocuments({ ingestId, state: 'pending' });
  }

  async deleteFrontier(ingestId: string): Promise<void> {
    await this.frontier.deleteMany({ ingestId });
  }

  async getConversations(): Promise<Conversation[]> {
    return (await this.conversations.find({}).toArray()).map((doc) => fromDoc<Conversation>(doc));
  }

  async getConversation(ownerId: string, id: string): Promise<Conversation | undefined> {
    const doc = await this.conversations.findOne({ _id: id as any, ownerId });
    return doc ? fromDoc<Conversation>(doc) : undefined;
  }

  async allowToolInConversation(ownerId: string, conversationId: string, tool: string): Promise<boolean> {
    const result = await this.conversations.updateOne({ _id: conversationId as any, ownerId }, { $addToSet: { allowedTools: tool } });
    return result.matchedCount > 0;
  }

  async setConversationAutoMode(ownerId: string, conversationId: string, on: boolean): Promise<boolean> {
    const result = await this.conversations.updateOne(
      { _id: conversationId as any, ownerId },
      on ? { $set: { autoMode: true } } : { $unset: { autoMode: '' } },
    );
    return result.matchedCount > 0;
  }

  async bindConversation(ownerId: string, conversationId: string, binding: { treeId: string; projectId?: string | undefined }): Promise<boolean> {
    const set = { treeId: binding.treeId, ...(binding.projectId ? { projectId: binding.projectId } : {}), updatedAt: new Date().toISOString() };
    const result = await this.conversations.updateOne({ _id: conversationId as any, ownerId, treeId: { $exists: false } }, { $set: set });
    return result.modifiedCount > 0;
  }

  async appendMessage(ownerId: string, conversationId: string, message: ConversationMessage): Promise<boolean> {
    const result = await this.conversations.updateOne({ _id: conversationId as any, ownerId }, { $push: { messages: message as any }, $set: { updatedAt: message.at } });
    return result.modifiedCount > 0;
  }

  async appendNotice(ownerId: string, conversationId: string, message: ConversationMessage): Promise<boolean> {
    if (!message.notice) return false;
    const result = await this.conversations.updateOne(
      { _id: conversationId as any, ownerId, 'messages.notice.key': { $ne: message.notice.key } },
      { $push: { messages: message as any }, $set: { updatedAt: message.at } },
    );
    return result.modifiedCount > 0;
  }

  async ownsRun(ownerId: string, runId: string): Promise<boolean> {
    return (await this.turnLogs.countDocuments({ ownerId, $or: [{ turnId: runId }, { 'events.runId': runId }] }, { limit: 1 })) > 0;
  }

  async runOrigin(ownerId: string, runId: string): Promise<{ agentId?: string | undefined; turnId: string } | undefined> {
    const found = await this.turnLogs.findOne(
      { ownerId, events: { $elemMatch: { runId, type: 'run.started' } } },
      { projection: { turnId: 1, events: { $elemMatch: { runId, type: 'run.started' } } } },
    ) as { turnId?: string; events?: { agentId?: string }[] } | null;
    if (!found?.turnId) return undefined;
    const agentId = found.events?.[0]?.agentId;
    return { turnId: found.turnId, ...(agentId ? { agentId } : {}) };
  }

  async saveConversation(conversation: Conversation): Promise<void> {
    const doc = toDoc(conversation);
    const id = doc._id;
    const { _id, ...rest } = doc;
    try {
      await this.conversations.replaceOne({ _id: id, ownerId: conversation.ownerId }, rest, { upsert: true });
    } catch (err) {
      if ((err as { code?: number }).code === 11000) throw new Error('You have no conversation with that id.');
      throw err;
    }
  }

  async deleteConversation(id: string): Promise<void> {
    await this.conversations.deleteOne({ _id: id as any });
  }

  async getWorkspaceImages(ownerId?: string): Promise<WorkspaceImageSpec[]> {
    const filter = ownerId ? { $or: [{ ownerId }, { ownerId: { $exists: false } }] } : {};
    const docs = await this.workspaceImages.find(filter).toArray();
    return docs.map(({ _id, ...rest }) => rest as unknown as WorkspaceImageSpec);
  }

  async saveWorkspaceImage(image: WorkspaceImageSpec): Promise<void> {
    const { _id: _ignored, ...doc } = image as WorkspaceImageSpec & { _id?: unknown };
    await this.workspaceImages.replaceOne(
      { _id: `${image.ownerId}:${image.id}` } as never,
      doc,
      { upsert: true },
    );
  }

  async findRunEffort(runId: string): Promise<RunEffort | undefined> {
    const doc = await this.runEffort.findOne({ _id: runId as never });
    if (!doc) return undefined;
    const { _id, ...effort } = doc;
    return effort as unknown as RunEffort;
  }

  private async reownArtifacts(from: string, to: string, runIds?: readonly string[] | undefined): Promise<{ modifiedCount: number }> {
    const moving = await this.artifacts.find({ ownerId: from, ...(runIds ? { runId: { $in: [...runIds] } } : {}) }).project({ _id: 1 }).toArray();
    if (moving.length === 0) return { modifiedCount: 0 };
    const ids = moving.map((doc) => doc._id);
    await this.artifactChunks.updateMany({ artifactId: { $in: ids as never[] } }, { $set: { ownerId: to } });
    return this.artifacts.updateMany({ _id: { $in: ids as never[] } }, { $set: { ownerId: to } });
  }

  async reownRuns(from: string, to: string, runIds?: readonly string[] | undefined): Promise<number> {
    if (runIds && runIds.length === 0) return 0;
    const runs = runIds ? { runId: { $in: [...runIds] } } : {};
    const turns = runIds ? { turnId: { $in: [...runIds] } } : {};
    const moved = await Promise.all([
      this.db().collection('engineRunTraces').updateMany({ ownerId: from, ...runs }, { $set: { ownerId: to } }),
      this.turnLogs.updateMany({ ownerId: from, ...turns }, { $set: { ownerId: to } }),
      this.runEffort.updateMany({ ownerId: from, ...runs }, { $set: { ownerId: to } }),
      this.reownArtifacts(from, to, runIds),
    ]);
    return moved.reduce((total, result) => total + result.modifiedCount, 0);
  }

  async getMcpToolHints(ownerId: string): Promise<McpToolHint[]> {
    const docs = await this.mcpToolHints.find({ ownerId }).toArray();
    return docs.map(({ _id, ...hint }) => hint as unknown as McpToolHint);
  }

  async deleteMcpToolHint(ownerId: string, server: string, tool: string): Promise<void> {
    await this.mcpToolHints.deleteOne({ _id: hintKey(ownerId, server, tool) as any });
  }

  async getMcpRequests(ownerId: string, conversationId?: string): Promise<McpRequest[]> {
    const query = conversationId === undefined ? { ownerId } : { ownerId, conversationId };
    const docs = await this.mcpRequests.find(query).sort({ createdAt: 1 }).toArray();
    return docs.map((d: Record<string, unknown>) => fromDoc<McpRequest>(d));
  }

  async getMcpRequest(ownerId: string, id: string): Promise<McpRequest | undefined> {
    const doc = await this.mcpRequests.findOne({ _id: id as any, ownerId });
    return doc ? fromDoc<McpRequest>(doc as Record<string, unknown>) : undefined;
  }

  async getActionProposals(ownerId: string, filter: { conversationId?: string | undefined; treeId?: string | undefined } = {}): Promise<ActionProposal[]> {
    const query: Record<string, unknown> = { ownerId };
    if (filter.conversationId !== undefined) query.conversationId = filter.conversationId;
    if (filter.treeId !== undefined) query.treeId = filter.treeId;
    const docs = await this.actionProposals.find(query).sort({ createdAt: 1 }).toArray();
    return docs.map((d: Record<string, unknown>) => fromDoc<ActionProposal>(d));
  }

  async getActionProposal(ownerId: string, id: string): Promise<ActionProposal | undefined> {
    const doc = await this.actionProposals.findOne({ _id: id as any, ownerId });
    return doc ? fromDoc<ActionProposal>(doc as Record<string, unknown>) : undefined;
  }

  async saveActionProposal(proposal: ActionProposal): Promise<void> {
    const doc = toDoc(proposal);
    const id = doc._id;
    const { _id, ...rest } = doc;
    await this.actionProposals.replaceOne({ _id: id }, rest, { upsert: true });
  }

  async getExtensionSettings(ownerId: string): Promise<ExtensionSettings | undefined> {
    const doc = await this.extensionSettings.findOne({ _id: ownerId as never });
    if (!doc) return undefined;
    const { _id, ...rest } = doc as Record<string, unknown>;
    return { ...(rest as Omit<ExtensionSettings, 'ownerId'>), ownerId: String(_id) };
  }

  async getAuthoredExtensions(ownerId: string): Promise<AuthoredExtension[]> {
    const docs = await this.authoredExtensions.find({ ownerId }).toArray();
    return docs.map((doc) => {
      const { _id, ...rest } = doc as Record<string, unknown>;
      return rest as unknown as AuthoredExtension;
    });
  }

  async saveAuthoredExtension(extension: AuthoredExtension): Promise<void> {
    await this.authoredExtensions.replaceOne({ _id: `${extension.ownerId}:${extension.id}` as never }, extension, { upsert: true });
  }

  async deleteAuthoredExtension(ownerId: string, id: string): Promise<void> {
    await this.authoredExtensions.deleteOne({ _id: `${ownerId}:${id}` as never });
  }

  async saveExtensionSettings(settings: ExtensionSettings): Promise<void> {
    const { ownerId, ...rest } = settings;
    await this.extensionSettings.replaceOne({ _id: ownerId as never }, rest, { upsert: true });
  }

  async getAutoModeSettings(ownerId: string): Promise<AutoModeSettings | undefined> {
    const doc = await this.autoModeSettings.findOne({ _id: ownerId as never });
    if (!doc) return undefined;
    const { _id, ...rest } = doc as Record<string, unknown>;
    return { ...(rest as Omit<AutoModeSettings, 'ownerId'>), ownerId: String(_id) };
  }

  async saveAutoModeSettings(settings: AutoModeSettings): Promise<void> {
    const { ownerId, ...rest } = settings;
    await this.autoModeSettings.replaceOne({ _id: ownerId as never }, rest, { upsert: true });
  }

  async saveMcpRequest(request: McpRequest): Promise<void> {
    const doc = toDoc(request);
    const id = doc._id;
    const { _id, ...rest } = doc;
    await this.mcpRequests.replaceOne({ _id: id }, rest, { upsert: true });
  }

  async getProcedure(ownerId: string, id: string): Promise<ProcedureSource | undefined> {
    const doc = await this.procedures.findOne({ _id: procedureKey(ownerId, id) as any });
    if (!doc) return undefined;
    const { _id, ...rest } = doc;
    return rest as unknown as ProcedureSource;
  }

  async getProcedures(ownerId?: string): Promise<ProcedureSource[]> {
    const filter = ownerId === undefined ? {} : { $or: [{ ownerId }, { ownerId: { $exists: false } }] };
    const docs = await this.procedures.find(filter).toArray();
    return docs.map((doc) => {
      const { _id, ...rest } = doc;
      return rest as unknown as ProcedureSource;
    });
  }

  async saveProcedure(source: ProcedureSource): Promise<void> {
    await this.procedures.replaceOne(
      { _id: procedureKey(source.ownerId, source.id) as any },
      { ...source },
      { upsert: true },
    );
  }

  async saveRunTraces(traces: StoredNodeTrace[]): Promise<void> {
    if (traces.length === 0) return;
    await this.runTraces.bulkWrite(traces.map((trace) => ({
      replaceOne: {
        filter: { _id: runTraceKey(trace.runId, trace.sequence) as any },
        replacement: { ...trace },
        upsert: true,
      },
    })));
  }

  async saveRunEffort(effort: RunEffort): Promise<void> {
    await this.runEffort.replaceOne({ _id: effort.runId as any }, { ...effort }, { upsert: true });
  }

  async getRunEffort(ownerId: string, procedureId: string, modelKey?: string): Promise<RunEffort[]> {
    const docs = await this.runEffort
      .find({ ownerId, procedureId, ...(modelKey ? { modelKey } : {}) })
      .sort({ finishedAt: -1 })
      .limit(500)
      .toArray();
    return docs.map(({ _id, ...rest }) => rest as unknown as RunEffort);
  }

  async appendTurnLog(entry: TurnLogEntry): Promise<void> {
    await this.turnLogs.insertOne({ ...entry, at: new Date(entry.at) });
  }

  async getTurnLog(ownerId: string, turnId: string, after: number): Promise<TurnLogEntry[]> {
    const docs = await this.turnLogs.find({ ownerId, turnId, seq: { $gt: after } }).sort({ seq: 1 }).toArray();
    return docs.map(({ _id, at, ...rest }) => ({ ...rest, at: (at as Date).toISOString() }) as unknown as TurnLogEntry);
  }

  async getTurnLogMarks(ownerId: string, turnId: string, types: readonly string[]): Promise<RunMark[]> {
    const field = (name: string) => ({ $ifNull: [`$events.${name}`, '$$REMOVE'] });
    return (await this.turnLogs.aggregate([
      { $match: { ownerId, turnId } },
      { $sort: { seq: 1 } },
      { $unwind: '$events' },
      { $match: { 'events.type': { $in: [...types] } } },
      { $project: {
        _id: 0,
        type: '$events.type',
        runId: '$events.runId',
        parentRunId: field('parentRunId'),
        agentId: field('agentId'),
        callId: field('callId'),
        tool: field('tool'),
        level: field('level'),
        message: { $cond: [{ $eq: [{ $type: '$events.message' }, 'string'] }, { $substrCP: ['$events.message', 0, MARK_MESSAGE_CHARS] }, '$$REMOVE'] },
      } },
    ]).toArray()) as unknown as RunMark[];
  }

  async recentTurns(ownerId: string, since: string, limit: number): Promise<TurnLogEntry[]> {
    const docs = await this.turnLogs.find({ ownerId, seq: 1, at: { $gte: new Date(since) } }).sort({ at: -1 }).limit(limit).toArray();
    return docs.map(({ _id, at, ...rest }) => ({ ...rest, at: (at as Date).toISOString() }) as unknown as TurnLogEntry);
  }

  async lastTurnLogSeq(turnId: string): Promise<number> {
    const [last] = await this.turnLogs.find({ turnId }).sort({ seq: -1 }).limit(1).toArray();
    return (last?.seq as number | undefined) ?? 0;
  }

  async getRunTraces(ownerId: string, runId: string): Promise<StoredNodeTrace[]> {
    const docs = await this.runTraces.find({ ownerId, runId }).sort({ sequence: 1 }).toArray();
    return docs.map(({ _id, ...rest }) => rest as unknown as StoredNodeTrace);
  }

  async deleteProcedure(ownerId: string | undefined, id: string): Promise<void> {
    await this.procedures.deleteOne({ _id: procedureKey(ownerId, id) as any });
  }

  async getEnginePersonas(ownerId?: string): Promise<EnginePersona[]> {
    const filter = ownerId === undefined ? {} : { $or: [{ ownerId }, { ownerId: { $exists: false } }] };
    const docs = await this.enginePersonas.find(filter).toArray();
    return docs.map((doc) => {
      const { _id, ...rest } = doc;
      return rest as unknown as EnginePersona;
    });
  }

  async getEngineTools(ownerId?: string): Promise<EngineTool[]> {
    const filter = ownerId === undefined ? {} : { $or: [{ ownerId }, { ownerId: { $exists: false } }] };
    const docs = await this.engineTools.find(filter).toArray();
    return docs.map((doc) => {
      const { _id, ...rest } = doc;
      return rest as unknown as EngineTool;
    });
  }

  async saveEngineTool(tool: EngineTool): Promise<void> {
    await this.engineTools.replaceOne(
      { _id: `${tool.ownerId ?? 'builtin'}:${tool.name}` as any },
      { ...tool },
      { upsert: true },
    );
  }

  async deleteEngineTool(ownerId: string | undefined, name: string): Promise<void> {
    await this.engineTools.deleteOne({ _id: `${ownerId ?? 'builtin'}:${name}` as any });
  }

  async saveEnginePersona(persona: EnginePersona): Promise<void> {
    await this.enginePersonas.replaceOne(
      { _id: `${persona.ownerId ?? 'builtin'}:${persona.slug}` as any },
      { ...persona },
      { upsert: true },
    );
  }

  async deleteEnginePersona(ownerId: string | undefined, slug: string): Promise<void> {
    await this.enginePersonas.deleteOne({ _id: `${ownerId ?? 'builtin'}:${slug}` as any });
  }

  async getPublishedWorkspace(ownerId: string, treeId: string): Promise<PublishedWorkspace | undefined> {
    const doc = await this.publishedWorkspaces.findOne({ _id: `${ownerId}:${treeId}` as any });
    if (!doc) return undefined;
    const { _id, ...rest } = doc;
    return rest as unknown as PublishedWorkspace;
  }

  async savePublishedWorkspace(workspace: PublishedWorkspace): Promise<void> {
    await this.publishedWorkspaces.replaceOne({ _id: `${workspace.ownerId}:${workspace.treeId}` as any }, { ...workspace }, { upsert: true });
  }

  async getPublishedWorkspaces(ownerId: string): Promise<PublishedWorkspace[]> {
    const docs = await this.publishedWorkspaces.find({ ownerId }).toArray();
    return docs.map(({ _id, ...rest }) => rest as unknown as PublishedWorkspace);
  }

  async deletePublishedWorkspace(ownerId: string, treeId: string): Promise<void> {
    await this.publishedWorkspaces.deleteOne({ _id: `${ownerId}:${treeId}` as any });
  }

  async getMcpServers(ownerId: string): Promise<McpServerRecord[]> {
    const docs = await this.mcpServers.find({ ownerId }).sort({ name: 1 }).toArray();
    return docs.map(({ _id, ...rest }) => rest as unknown as McpServerRecord);
  }

  async saveMcpServer(server: McpServerRecord): Promise<void> {
    await this.mcpServers.replaceOne({ _id: `${server.ownerId}:${server.id}` as any }, { ...server }, { upsert: true });
  }

  async deleteMcpServer(ownerId: string, id: string): Promise<void> {
    await this.mcpServers.deleteOne({ _id: `${ownerId}:${id}` as any });
  }

  async getWorkspaceDependencies(ownerId: string): Promise<WorkspaceDependency[]> {
    const docs = await this.workspaceDependencies.find({ ownerId }).sort({ name: 1 }).toArray();
    return docs.map(({ _id, ...rest }) => rest as unknown as WorkspaceDependency);
  }

  async saveWorkspaceDependency(dependency: WorkspaceDependency & { ownerId: string }): Promise<void> {
    await this.workspaceDependencies.replaceOne({ _id: `${dependency.ownerId}:${dependency.name}` as any }, { ...dependency }, { upsert: true });
  }

  async deleteWorkspaceDependency(ownerId: string, name: string): Promise<void> {
    await this.workspaceDependencies.deleteOne({ _id: `${ownerId}:${name}` as any });
  }

  async getToolGrants(ownerId: string): Promise<ToolGrant[]> {
    const docs = await this.toolGrants.find({ ownerId }).sort({ grantedAt: 1, _id: 1 }).toArray();
    return docs.map(({ _id, ...rest }) => rest as unknown as ToolGrant);
  }

  async saveToolGrant(grant: ToolGrant & { ownerId: string }): Promise<void> {
    await this.toolGrants.replaceOne({ _id: toolGrantKey(grant.ownerId, grant.agent, grant.tool, grant.kind) as any }, { ...grant }, { upsert: true });
  }

  async deleteToolGrant(ownerId: string, agent: string, tool: string, kind?: GrantKind | undefined): Promise<void> {
    await this.toolGrants.deleteOne({ _id: toolGrantKey(ownerId, agent, tool, kind) as any });
  }

  async deleteToolGrantsFor(ownerId: string | undefined, of: { agent?: string; tool?: string; kind?: GrantKind | undefined }): Promise<number> {
    const filter = { ...(ownerId === undefined ? {} : { ownerId }), ...(of.agent ? { agent: of.agent } : {}), ...(of.tool ? { tool: of.tool } : {}), ...kindFilter(of.kind) };
    return (await this.toolGrants.deleteMany(filter)).deletedCount;
  }
}

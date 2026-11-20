import { describe, expect, it } from 'vitest';
import type { ActionProposal, McpRequest } from '@koala/harness-types';
import type { PersonaRecord, ToolDefinition, ToolGrant, WorkspaceDependency } from '@koala/agent-engine';
import type { EngineEvent } from '@koala/agent-engine';
import type { RunEffort } from '@koala/agent-engine/procedure';
import type { FrontierUrl } from '../../platform/index.js';
import type { AuthoredExtension } from '../lib/authored-extensions.js';
import type { Conversation, ConversationMessage } from '../lib/conversations.js';
import type { CorpusPage } from '../lib/corpus.js';
import type { McpServerRecord } from '../lib/mcp-servers.js';
import { MARK_MESSAGE_CHARS, type TurnLogEntry } from '../lib/turn-log.js';
import type { PoisoningSignal } from '../lib/poisoning.js';
import type { ProcedureSource } from '../lib/procedure-source.js';
import type { PublishedWorkspace } from '../lib/published-workspace.js';
import type { RunGrant } from '../lib/run-grants.js';
import type { StoredNodeTrace } from '../lib/run-traces.js';
import type { WorkspaceImageSpec } from '../lib/workspace-image-seeds.js';
import type { EngineStore } from '../store.js';

const start = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 3_600_000;
const at = (minute: number): string => new Date(start + minute * 60_000).toISOString();

const conversation = (over: Partial<Conversation> = {}): Conversation => ({ id: 'chat-1', ownerId: 'owner-1', title: 'A chat', messages: [], createdAt: at(0), updatedAt: at(0), ...over });
const said = (content: string, minute: number): ConversationMessage => ({ role: 'user', content, at: at(minute) });
const notice = (key: string, minute: number): ConversationMessage => ({ role: 'notice', author: { kind: 'platform' }, content: `notice ${key}`, at: at(minute), notice: { key, kind: 'tree-quiet', text: `notice ${key}`, refs: {}, actions: [] } });

const started = (runId: string, agentId: string, parentRunId?: string): EngineEvent => ({ type: 'run.started', runId, at: at(0), agentId, loopId: 'loop', ...(parentRunId ? { parentRunId } : {}) });
const noticed = (runId: string, message: string): EngineEvent => ({ type: 'notice', runId, at: at(0), level: 'warn', message });
const turn = (turnId: string, seq: number, events: EngineEvent[], over: Partial<TurnLogEntry> = {}): TurnLogEntry => ({ turnId, ownerId: 'owner-1', seq, events, at: at(seq), ...over });

const effort = (runId: string, over: Partial<RunEffort> = {}): RunEffort => ({
  runId, ownerId: 'owner-1', agentSlug: 'koala', procedureId: 'chat', procedureVersion: '1', modelKey: 'model-a', modelLabel: 'Model A', outcome: 'ok',
  rounds: 1, toolCalls: 0, totalTokens: 10, childRuns: 0, longestReply: 5, cappedAt: 0, steps: 3, wallClockMs: 100, ask: 'hello', limits: {}, finishedAt: at(1), ...over,
});

const trace = (runId: string, sequence: number, over: Partial<StoredNodeTrace> = {}): StoredNodeTrace => ({
  sequence, step: sequence, node: `node-${sequence}`, origin: `node-${sequence}`, kind: 'model-turn', role: 'step', cleanup: false, startedAt: sequence, durationMs: 1, inputs: { n: sequence },
  runId, ownerId: 'owner-1', agentSlug: 'koala', procedureId: 'chat', procedureVersion: '1', ...over,
});

const grant = (id: string, over: Partial<RunGrant> = {}): RunGrant => ({
  id, ownerId: 'owner-1', personId: 'owner-1', runId: `run-${id}`, principal: { kind: 'person', id: 'owner-1', claims: [] }, scope: {}, startedBy: 'person', state: 'live', issuedAt: at(0), ...over,
});

const signal = (id: string, over: Partial<PoisoningSignal> = {}): PoisoningSignal => ({
  id, ownerId: 'owner-1', kind: 'canary', severity: 'certain', state: 'open', at: at(1), readsKey: 'reads-1', runId: 'run-1', tool: 'fetch_web_page', said: 'the canary left', ...over,
});

const persona = (slug: string, ownerId?: string): PersonaRecord => ({
  slug, ...(ownerId ? { ownerId } : {}), name: slug, description: `${slug} does things`, version: '1', prompt: 'Be helpful.', guidance: '', returns: 'an answer', failures: [], procedure: 'chat', environment: {},
});

const tool = (name: string, ownerId?: string): ToolDefinition => ({
  name, ...(ownerId ? { ownerId } : {}), summary: `${name} tool`, binding: 'platform', effect: 'read', idempotent: true, openWorld: false, parameters: { type: 'object', properties: {} }, returns: 'text', failures: [],
});

const procedure = (id: string, ownerId?: string): ProcedureSource => ({ id, ...(ownerId ? { ownerId } : {}), version: '1', source: `{"id":"${id}"}`, updatedAt: at(0) });

const image = (id: WorkspaceImageSpec['id'], ownerId?: string): WorkspaceImageSpec => ({
  id, ...(ownerId ? { ownerId } : {}), image: `koala/${id}:1`, summary: `${id} image`, available: ['git'], absent: [], packageAccess: { env: [], egress: [] },
});

const page = (id: string, over: Partial<CorpusPage> = {}): CorpusPage => ({ id, ownerId: 'owner-1', ingestId: 'ingest-1', url: `https://example.com/${id}`, host: 'example.com', text: `text of ${id}`, bytes: 10, fetchedAt: at(0), ...over });

const frontierUrl = (ingestId: string, url: string, depth: number, rank: number): FrontierUrl => ({ id: `${ingestId}:${url}`, ingestId, url, depth, rank, state: 'pending' });

const mcpRequest = (id: string, over: Partial<McpRequest> = {}): McpRequest => ({ id, ownerId: 'owner-1', conversationId: 'chat-1', server: 'github', why: 'to read issues', status: 'requested', createdAt: at(1), updatedAt: at(1), ...over });

const proposal = (id: string, over: Partial<ActionProposal> = {}): ActionProposal => ({ id, ownerId: 'owner-1', kind: 'deploy_app', summary: 'Deploy it', detail: [], params: {}, status: 'proposed', createdAt: at(1), updatedAt: at(1), ...over });

const published = (treeId: string, ownerId = 'owner-1'): PublishedWorkspace => ({
  ownerId, treeId, file: { needs: ['node'] }, fingerprint: `fp-${treeId}`, image: `registry/${treeId}:1`, provides: ['node'], lines: [], env: [], baseEnv: [], publishedAt: at(0),
});

const server = (id: string, name: string, ownerId = 'owner-1'): McpServerRecord => ({ id, ownerId, name, runs: { where: 'hosted', url: `https://${name}.example.com/mcp` }, createdAt: at(0), updatedAt: at(0) });

const dependency = (name: string, ownerId = 'owner-1'): WorkspaceDependency & { ownerId: string } => ({ name, ownerId, summary: `${name} dependency`, provides: [name], install: [{ via: 'npm', packages: [name] }] });

const toolGrant = (agent: string, granted: string, over: Partial<ToolGrant & { ownerId: string }> = {}): ToolGrant & { ownerId: string } => ({ ownerId: 'owner-1', agent, tool: granted, ...over });

const extension = (id: string, ownerId = 'owner-1'): AuthoredExtension => ({ ownerId, id, title: id, describe: `${id} extension`, operations: [], tools: [], personas: [], procedures: [], createdAt: at(0), updatedAt: at(0) });

export function engineStoreContract(make: () => Promise<EngineStore>): void {
  describe('conversations', () => {
    it('keeps a conversation for its owner only, and replaces it whole when saved again', async () => {
      const store = await make();
      await store.saveConversation(conversation({ modelId: 'model-a', messages: [said('hello', 1)] }));
      expect(await store.getConversation('owner-1', 'chat-1')).toEqual(conversation({ modelId: 'model-a', messages: [said('hello', 1)] }));
      expect(await store.getConversation('owner-2', 'chat-1')).toBeUndefined();
      expect(await store.getConversation('owner-1', 'never')).toBeUndefined();
      await store.saveConversation(conversation({ title: 'Renamed' }));
      expect(await store.getConversation('owner-1', 'chat-1')).toEqual(conversation({ title: 'Renamed' }));
    });

    it('refuses to save over another person\'s conversation and leaves theirs as it was', async () => {
      const store = await make();
      await store.saveConversation(conversation());
      await expect(store.saveConversation(conversation({ ownerId: 'owner-2', title: 'Taken' }))).rejects.toThrow('You have no conversation with that id.');
      expect(await store.getConversation('owner-1', 'chat-1')).toEqual(conversation());
    });

    it('lists every person\'s conversations and forgets one when deleted', async () => {
      const store = await make();
      await store.saveConversation(conversation());
      await store.saveConversation(conversation({ id: 'chat-2', ownerId: 'owner-2' }));
      expect((await store.getConversations()).map((found) => found.id).sort()).toEqual(['chat-1', 'chat-2']);
      await store.deleteConversation('chat-1');
      expect((await store.getConversations()).map((found) => found.id)).toEqual(['chat-2']);
    });

    it('leaves out a field saved as undefined', async () => {
      const store = await make();
      await store.saveConversation(conversation({ modelId: undefined }));
      expect(await store.getConversation('owner-1', 'chat-1')).not.toHaveProperty('modelId');
    });

    it('hands back a copy, so changing what it read changes nothing stored', async () => {
      const store = await make();
      await store.saveConversation(conversation({ messages: [said('hello', 1)] }));
      const read = await store.getConversation('owner-1', 'chat-1');
      read!.title = 'changed';
      read!.messages.push(said('more', 2));
      expect(await store.getConversation('owner-1', 'chat-1')).toEqual(conversation({ messages: [said('hello', 1)] }));
    });

    it('appends a message for the owner and moves the conversation\'s updatedAt to it', async () => {
      const store = await make();
      await store.saveConversation(conversation({ messages: [said('first', 1)] }));
      expect(await store.appendMessage('owner-1', 'chat-1', said('second', 5))).toBe(true);
      expect(await store.appendMessage('owner-2', 'chat-1', said('intruder', 6))).toBe(false);
      expect(await store.appendMessage('owner-1', 'never', said('lost', 6))).toBe(false);
      expect(await store.getConversation('owner-1', 'chat-1')).toMatchObject({ messages: [said('first', 1), said('second', 5)], updatedAt: at(5) });
    });

    it('posts a notice once per key and refuses a message that is not a notice', async () => {
      const store = await make();
      await store.saveConversation(conversation());
      expect(await store.appendNotice('owner-1', 'chat-1', notice('tree-quiet:1', 2))).toBe(true);
      expect(await store.appendNotice('owner-1', 'chat-1', notice('tree-quiet:1', 3))).toBe(false);
      expect(await store.appendNotice('owner-1', 'chat-1', said('not a notice', 3))).toBe(false);
      expect(await store.appendNotice('owner-2', 'chat-1', notice('tree-quiet:2', 3))).toBe(false);
      expect(await store.appendNotice('owner-1', 'chat-1', notice('tree-quiet:2', 4))).toBe(true);
      const stored = await store.getConversation('owner-1', 'chat-1');
      expect(stored?.messages.map((message) => message.notice?.key)).toEqual(['tree-quiet:1', 'tree-quiet:2']);
      expect(stored?.updatedAt).toBe(at(4));
    });

    it('allows a tool in a conversation once, saying whether the conversation was the owner\'s', async () => {
      const store = await make();
      await store.saveConversation(conversation());
      expect(await store.allowToolInConversation('owner-1', 'chat-1', 'run_command')).toBe(true);
      expect(await store.allowToolInConversation('owner-1', 'chat-1', 'run_command')).toBe(true);
      expect(await store.allowToolInConversation('owner-1', 'chat-1', 'store_file')).toBe(true);
      expect(await store.allowToolInConversation('owner-2', 'chat-1', 'deploy')).toBe(false);
      expect((await store.getConversation('owner-1', 'chat-1'))?.allowedTools).toEqual(['run_command', 'store_file']);
    });

    it('switches auto mode on and off, removing the field when off', async () => {
      const store = await make();
      await store.saveConversation(conversation());
      expect(await store.setConversationAutoMode('owner-1', 'chat-1', true)).toBe(true);
      expect((await store.getConversation('owner-1', 'chat-1'))?.autoMode).toBe(true);
      expect(await store.setConversationAutoMode('owner-1', 'chat-1', false)).toBe(true);
      expect(await store.getConversation('owner-1', 'chat-1')).not.toHaveProperty('autoMode');
      expect(await store.setConversationAutoMode('owner-1', 'chat-1', false)).toBe(true);
      expect(await store.setConversationAutoMode('owner-2', 'chat-1', true)).toBe(false);
      expect(await store.setConversationAutoMode('owner-1', 'never', true)).toBe(false);
    });

    it('binds a conversation to a tree only once, and only for its owner', async () => {
      const store = await make();
      await store.saveConversation(conversation());
      await store.saveConversation(conversation({ id: 'chat-2' }));
      const before = Date.now();
      expect(await store.bindConversation('owner-2', 'chat-1', { treeId: 'tree-x' })).toBe(false);
      expect(await store.bindConversation('owner-1', 'chat-1', { treeId: 'tree-1', projectId: 'project-1' })).toBe(true);
      expect(await store.bindConversation('owner-1', 'chat-1', { treeId: 'tree-2' })).toBe(false);
      expect(await store.bindConversation('owner-1', 'chat-2', { treeId: 'tree-3' })).toBe(true);
      expect(await store.bindConversation('owner-1', 'never', { treeId: 'tree-4' })).toBe(false);
      const bound = await store.getConversation('owner-1', 'chat-1');
      expect(bound).toMatchObject({ treeId: 'tree-1', projectId: 'project-1' });
      expect(Date.parse(bound!.updatedAt)).toBeGreaterThanOrEqual(before - 1000);
      expect(await store.getConversation('owner-1', 'chat-2')).not.toHaveProperty('projectId');
    });
    it('drops attachments that name no kept file from every message, keeping the messages and anything else, once', async () => {
      const store = await make();
      const kept = { fileId: 'f1', name: 'brief.pdf', size: 3 };
      const old = { name: 'old.pdf', path: 'attachments/old.pdf' } as unknown as typeof kept;
      const blank = { fileId: '', name: 'blank.txt' };
      const mixed: ConversationMessage = { ...said('both', 1), attachments: [kept, old] };
      const onlyOld: ConversationMessage = { ...said('only the old one', 2), attachments: [old, blank] };
      const untouched: ConversationMessage = { ...said('kept only', 3), attachments: [kept] };
      await store.saveConversation(conversation({ messages: [mixed, onlyOld, said('none', 4)] }));
      await store.saveConversation(conversation({ id: 'chat-2', messages: [untouched] }));
      await store.saveConversation(conversation({ id: 'chat-3', ownerId: 'owner-2', messages: [{ ...said('theirs', 1), attachments: [old] }] }));
      expect(await store.dropUnkeptAttachments()).toBe(2);
      expect((await store.getConversation('owner-1', 'chat-1'))?.messages).toEqual([{ ...said('both', 1), attachments: [kept] }, said('only the old one', 2), said('none', 4)]);
      expect((await store.getConversation('owner-1', 'chat-2'))?.messages).toEqual([untouched]);
      expect((await store.getConversation('owner-2', 'chat-3'))?.messages).toEqual([said('theirs', 1)]);
      expect(await store.dropUnkeptAttachments()).toBe(0);
      expect((await store.getConversation('owner-1', 'chat-1'))?.messages).toEqual([{ ...said('both', 1), attachments: [kept] }, said('only the old one', 2), said('none', 4)]);
    });
  });

  describe('the turn log', () => {
    it('reads a turn\'s entries after a sequence number, in order, for its owner only', async () => {
      const store = await make();
      await store.appendTurnLog(turn('turn-1', 2, [noticed('run-1', 'two')]));
      await store.appendTurnLog(turn('turn-1', 1, [started('run-1', 'koala')]));
      await store.appendTurnLog(turn('turn-1', 3, [noticed('run-1', 'three')]));
      await store.appendTurnLog(turn('turn-2', 1, [started('run-2', 'koala')]));
      expect((await store.getTurnLog('owner-1', 'turn-1', 0)).map((entry) => entry.seq)).toEqual([1, 2, 3]);
      expect(await store.getTurnLog('owner-1', 'turn-1', 2)).toEqual([turn('turn-1', 3, [noticed('run-1', 'three')])]);
      expect(await store.getTurnLog('owner-2', 'turn-1', 0)).toEqual([]);
    });

    it('hands back each entry\'s time as an ISO string, normalised to milliseconds', async () => {
      const store = await make();
      await store.appendTurnLog(turn('turn-1', 1, [], { at: at(0).replace('.000Z', 'Z') }));
      expect((await store.getTurnLog('owner-1', 'turn-1', 0))[0]?.at).toBe(at(0));
    });

    it('refuses a second entry with the same turn and sequence number', async () => {
      const store = await make();
      await store.appendTurnLog(turn('turn-1', 1, []));
      await expect(store.appendTurnLog(turn('turn-1', 1, [noticed('run-1', 'again')]))).rejects.toThrow();
      await store.appendTurnLog(turn('turn-2', 1, []));
      expect(await store.getTurnLog('owner-1', 'turn-1', 0)).toEqual([turn('turn-1', 1, [])]);
    });

    it('hands back copies of entries, so changing what it read changes nothing stored', async () => {
      const store = await make();
      await store.appendTurnLog(turn('turn-1', 1, [started('turn-1', 'koala')]));
      const [read] = await store.getTurnLog('owner-1', 'turn-1', 0);
      read!.events.length = 0;
      expect(await store.getTurnLog('owner-1', 'turn-1', 0)).toEqual([turn('turn-1', 1, [started('turn-1', 'koala')])]);
    });

    it('knows the last sequence number of a turn, whoever owns it, and zero for none', async () => {
      const store = await make();
      await store.appendTurnLog(turn('turn-1', 1, []));
      await store.appendTurnLog(turn('turn-1', 7, [], { ownerId: 'owner-2' }));
      await store.appendTurnLog(turn('turn-1', 4, []));
      expect(await store.lastTurnLogSeq('turn-1')).toBe(7);
      expect(await store.lastTurnLogSeq('never')).toBe(0);
    });

    it('lists the owner\'s turns that began since a time, newest first, up to the limit', async () => {
      const store = await make();
      await store.appendTurnLog(turn('turn-old', 1, [], { at: at(1) }));
      await store.appendTurnLog(turn('turn-a', 1, [], { at: at(10) }));
      await store.appendTurnLog(turn('turn-a', 2, [], { at: at(11) }));
      await store.appendTurnLog(turn('turn-b', 1, [], { at: at(20) }));
      await store.appendTurnLog(turn('turn-c', 1, [], { at: at(30) }));
      await store.appendTurnLog(turn('turn-other', 1, [], { at: at(40), ownerId: 'owner-2' }));
      expect((await store.recentTurns('owner-1', at(10), 10)).map((entry) => entry.turnId)).toEqual(['turn-c', 'turn-b', 'turn-a']);
      expect((await store.recentTurns('owner-1', at(10), 2)).map((entry) => entry.turnId)).toEqual(['turn-c', 'turn-b']);
      expect((await store.recentTurns('owner-1', at(10), 0)).map((entry) => entry.turnId)).toEqual(['turn-c', 'turn-b', 'turn-a']);
      expect((await store.recentTurns('owner-1', at(10), 10))[2]).toEqual(turn('turn-a', 1, [], { at: at(10) }));
    });

    it('knows a run is the owner\'s when it is a turn of theirs or a run inside one', async () => {
      const store = await make();
      await store.appendTurnLog(turn('turn-1', 1, [started('turn-1', 'koala'), started('child-1', 'research', 'turn-1')]));
      expect(await store.ownsRun('owner-1', 'turn-1')).toBe(true);
      expect(await store.ownsRun('owner-1', 'child-1')).toBe(true);
      expect(await store.ownsRun('owner-2', 'child-1')).toBe(false);
      expect(await store.ownsRun('owner-1', 'never')).toBe(false);
    });

    it('finds the turn a run started in and the agent that ran it', async () => {
      const store = await make();
      await store.appendTurnLog(turn('turn-1', 1, [started('turn-1', 'koala')]));
      await store.appendTurnLog(turn('turn-1', 2, [noticed('child-1', 'before'), started('child-1', 'research', 'turn-1')]));
      await store.appendTurnLog(turn('turn-2', 1, [started('child-2', '', 'turn-2')]));
      expect(await store.runOrigin('owner-1', 'child-1')).toEqual({ turnId: 'turn-1', agentId: 'research' });
      expect(await store.runOrigin('owner-1', 'child-2')).toEqual({ turnId: 'turn-2' });
      expect(await store.runOrigin('owner-2', 'child-1')).toBeUndefined();
      expect(await store.runOrigin('owner-1', 'never')).toBeUndefined();
    });

    it('marks the events of the named types in order, keeping only the fields they carry and a message cut short', async () => {
      const store = await make();
      const long = 'x'.repeat(MARK_MESSAGE_CHARS + 50);
      await store.appendTurnLog(turn('turn-1', 2, [
        { type: 'tool.result', runId: 'child-1', at: at(2), nodeId: 'tools', callId: 'call-1', ok: true, digest: 'done' },
        noticed('child-1', long),
      ]));
      await store.appendTurnLog(turn('turn-1', 1, [
        started('turn-1', 'koala'),
        { type: 'node.entered', runId: 'turn-1', at: at(1), nodeId: 'model' },
        started('child-1', 'research', 'turn-1'),
      ]));
      await store.appendTurnLog(turn('turn-1', 3, [noticed('run-x', 'not mine')], { ownerId: 'owner-2' }));
      expect(await store.getTurnLogMarks('owner-1', 'turn-1', ['run.started', 'notice', 'tool.result'])).toEqual([
        { type: 'run.started', runId: 'turn-1', agentId: 'koala' },
        { type: 'run.started', runId: 'child-1', agentId: 'research', parentRunId: 'turn-1' },
        { type: 'tool.result', runId: 'child-1', callId: 'call-1' },
        { type: 'notice', runId: 'child-1', level: 'warn', message: 'x'.repeat(MARK_MESSAGE_CHARS) },
      ]);
      expect(await store.getTurnLogMarks('owner-1', 'turn-1', [])).toEqual([]);
    });
  });

  describe('run traces and effort', () => {
    it('keeps a run\'s traces in sequence for its owner, replacing one saved again at the same place', async () => {
      const store = await make();
      await store.saveRunTraces([trace('run-1', 2), trace('run-1', 1), trace('run-2', 1)]);
      await store.saveRunTraces([trace('run-1', 2, { durationMs: 99 })]);
      await store.saveRunTraces([]);
      expect(await store.getRunTraces('owner-1', 'run-1')).toEqual([trace('run-1', 1), trace('run-1', 2, { durationMs: 99 })]);
      expect(await store.getRunTraces('owner-2', 'run-1')).toEqual([]);
    });

    it('keeps one effort per run and finds it by its run', async () => {
      const store = await make();
      await store.saveRunEffort(effort('run-1'));
      await store.saveRunEffort(effort('run-1', { rounds: 4 }));
      expect(await store.findRunEffort('run-1')).toEqual(effort('run-1', { rounds: 4 }));
      expect(await store.findRunEffort('never')).toBeUndefined();
    });

    it('lists the owner\'s efforts on a procedure newest first, on one model when named', async () => {
      const store = await make();
      await store.saveRunEffort(effort('run-1', { finishedAt: at(1) }));
      await store.saveRunEffort(effort('run-3', { finishedAt: at(3), modelKey: 'model-b' }));
      await store.saveRunEffort(effort('run-2', { finishedAt: at(2) }));
      await store.saveRunEffort(effort('run-4', { procedureId: 'research' }));
      await store.saveRunEffort(effort('run-5', { ownerId: 'owner-2' }));
      expect((await store.getRunEffort('owner-1', 'chat')).map((found) => found.runId)).toEqual(['run-3', 'run-2', 'run-1']);
      expect((await store.getRunEffort('owner-1', 'chat', 'model-a')).map((found) => found.runId)).toEqual(['run-2', 'run-1']);
      expect((await store.getRunEffort('owner-1', 'chat', '')).map((found) => found.runId)).toEqual(['run-3', 'run-2', 'run-1']);
    });

    it('lists at most five hundred efforts', async () => {
      const store = await make();
      await Promise.all(Array.from({ length: 502 }, (_, n) => store.saveRunEffort(effort(`run-${n}`, { finishedAt: new Date(Date.UTC(2026, 9, 1) + n * 1000).toISOString() }))));
      const found = await store.getRunEffort('owner-1', 'chat');
      expect(found).toHaveLength(500);
      expect(found[0]?.runId).toBe('run-501');
    });
  });

  describe('handing runs to another owner', () => {
    it('moves the named runs\' traces, turn log, effort, endings, grants and signals and counts what moved', async () => {
      const store = await make();
      await store.saveRunTraces([trace('run-1', 1), trace('run-1', 2), trace('run-2', 1)]);
      await store.appendTurnLog(turn('run-1', 1, [started('run-1', 'koala')], { ownerId: 'space' }));
      await store.appendTurnLog(turn('run-1', 2, [], { ownerId: 'space' }));
      await store.saveRunTraces([trace('run-1', 3, { ownerId: 'space' }), trace('run-1', 4, { ownerId: 'space' }), trace('run-2', 2, { ownerId: 'space' })]);
      await store.saveRunEffort(effort('run-1', { ownerId: 'space' }));
      await store.saveRunEnded({ runId: 'run-1', ownerId: 'space', ended: { how: 'finished', at: at(1) } });
      await store.saveRunGrant(grant('g1', { ownerId: 'space', runId: 'run-1' }));
      await store.savePoisoningSignal(signal('s1', { ownerId: 'space', runId: 'run-1' }));
      await store.savePoisoningSignal(signal('s2', { ownerId: 'space', runId: 'run-2' }));
      expect(await store.reownRuns('space', 'owner-1', ['run-1'])).toBe(8);
      expect((await store.getRunTraces('owner-1', 'run-1')).map((found) => found.sequence)).toEqual([1, 2, 3, 4]);
      expect(await store.getTurnLog('owner-1', 'run-1', 0)).toHaveLength(2);
      expect(await store.findRunEffort('run-1')).toMatchObject({ ownerId: 'owner-1' });
      expect(await store.getRunEndings('owner-1', ['run-1'])).toHaveLength(1);
      expect(await store.getRunGrant('g1')).toMatchObject({ ownerId: 'owner-1' });
      expect((await store.getPoisoningSignals('owner-1')).map((found) => found.id)).toEqual(['s1']);
      expect(await store.getRunTraces('space', 'run-2')).toHaveLength(1);
    });

    it('moves every run of the owner when none are named, and nothing for an empty list or the same owner', async () => {
      const store = await make();
      await store.saveRunTraces([trace('run-1', 1, { ownerId: 'space' }), trace('run-2', 1, { ownerId: 'space' }), trace('run-3', 1)]);
      expect(await store.reownRuns('space', 'owner-1', [])).toBe(0);
      expect(await store.reownRuns('owner-1', 'owner-1')).toBe(0);
      expect(await store.reownRuns('space', 'owner-1')).toBe(2);
      expect(await store.getRunTraces('owner-1', 'run-2')).toHaveLength(1);
      expect(await store.reownRuns('space', 'owner-1')).toBe(0);
    });
  });

  describe('run grants and endings', () => {
    it('keeps a grant, finds it by id or by its run, and lists a person\'s live ones', async () => {
      const store = await make();
      await store.saveRunGrant(grant('g1'));
      await store.saveRunGrant(grant('g2', { state: 'ended', endedAt: at(2) }));
      await store.saveRunGrant(grant('g3', { personId: 'owner-2' }));
      expect(await store.getRunGrant('g1')).toEqual(grant('g1'));
      expect(await store.getRunGrant('never')).toBeUndefined();
      expect(await store.getRunGrantOfRun('run-g2')).toEqual(grant('g2', { state: 'ended', endedAt: at(2) }));
      expect(await store.getRunGrantOfRun('never')).toBeUndefined();
      expect((await store.getLiveRunGrants('owner-1')).map((found) => found.id)).toEqual(['g1']);
      await store.saveRunGrant(grant('g1', { state: 'revoked', revokedBecause: 'signed-out-everywhere' }));
      expect(await store.getLiveRunGrants('owner-1')).toEqual([]);
    });

    it('removes a grant issued for a start that never began, leaving every other grant', async () => {
      const store = await make();
      await store.saveRunGrant(grant('g1'));
      await store.saveRunGrant(grant('g2'));
      await store.deleteRunGrant('g2');
      expect(await store.getRunGrant('g2')).toBeUndefined();
      expect(await store.getRunGrantOfRun('run-g2')).toBeUndefined();
      expect((await store.getLiveRunGrants('owner-1')).map((found) => found.id)).toEqual(['g1']);
    });

    it('records how a run ended and its handover together, whichever comes first', async () => {
      const store = await make();
      await store.saveRunHandover('owner-1', 'run-1', { note: 'left halfway', path: 'handover/run-1.md' });
      await store.saveRunEnded({ runId: 'run-1', ownerId: 'owner-1', agentSlug: 'research', depth: 1, ended: { how: 'revoked', revokedBecause: 'account-removed', at: at(3) } });
      await store.saveRunEnded({ runId: 'run-2', ownerId: 'owner-1', ended: { how: 'finished', at: at(4) } });
      await store.saveRunHandover('owner-1', 'run-2', { failed: 'no model' });
      await store.saveRunEnded({ runId: 'run-3', ownerId: 'owner-2', ended: { how: 'failed', reason: 'boom', at: at(5) } });
      const endings = await store.getRunEndings('owner-1', ['run-1', 'run-2', 'run-3']);
      expect(endings).toEqual(expect.arrayContaining([
        { runId: 'run-1', ownerId: 'owner-1', agentSlug: 'research', depth: 1, ended: { how: 'revoked', revokedBecause: 'account-removed', at: at(3) }, handover: { note: 'left halfway', path: 'handover/run-1.md' } },
        { runId: 'run-2', ownerId: 'owner-1', ended: { how: 'finished', at: at(4) }, handover: { failed: 'no model' } },
      ]));
      expect(endings).toHaveLength(2);
      expect(await store.getRunEndings('owner-1', [])).toEqual([]);
    });
  });

  describe('what runs read', () => {
    it('opens a run family\'s reads once, adding each run that opens it and keeping who opened it first', async () => {
      const store = await make();
      expect(await store.openRunReads('family-1', 'owner-1', 'run-1', 'fp-1', at(1))).toEqual({
        key: 'family-1', ownerId: 'owner-1', fpKey: 'fp-1', runs: ['run-1'], classes: [], private: [], outside: [], hosts: [], lastReadAt: at(1),
      });
      await store.openRunReads('family-1', 'owner-2', 'run-1', 'fp-2', at(2));
      expect(await store.openRunReads('family-1', 'owner-2', 'run-2', 'fp-2', at(3))).toEqual({
        key: 'family-1', ownerId: 'owner-1', fpKey: 'fp-1', runs: ['run-1', 'run-2'], classes: [], private: [], outside: [], hosts: [], lastReadAt: at(3),
      });
    });

    it('adds what was read without repeating classes, hosts or runs, and keeps every fingerprint in order', async () => {
      const store = await make();
      await store.openRunReads('family-1', 'owner-1', 'run-1', 'fp-1', at(1));
      await store.addRunReads('family-1', { classes: ['web'], private: [], outside: ['a', 'b'], hosts: ['example.com'] }, at(2));
      await store.addRunReads('family-1', { classes: ['web', 'logs'], private: ['p'], outside: ['b', 'c'], hosts: ['example.com', 'other.org'], readRuns: ['run-9', 'run-9'] }, at(3));
      const [reads] = await store.getRunReadsOfRuns(['run-1']);
      expect(reads).toEqual({
        key: 'family-1', ownerId: 'owner-1', fpKey: 'fp-1', runs: ['run-1'], classes: ['web', 'logs'], private: ['p'], outside: ['a', 'b', 'b', 'c'], hosts: ['example.com', 'other.org'], readRuns: ['run-9'], lastReadAt: at(3),
      });
    });

    it('starts the list of runs read as soon as anything is added', async () => {
      const store = await make();
      await store.openRunReads('family-1', 'owner-1', 'run-1', 'fp-1', at(1));
      await store.addRunReads('family-1', { classes: [], private: [], outside: [], hosts: ['example.com'] }, at(2));
      expect((await store.getRunReadsOfRuns(['run-1']))[0]).toMatchObject({ readRuns: [], hosts: ['example.com'], lastReadAt: at(2) });
    });

    it('changes nothing when nothing was read or the family was never opened', async () => {
      const store = await make();
      await store.openRunReads('family-1', 'owner-1', 'run-1', 'fp-1', at(1));
      await store.addRunReads('family-1', { classes: [], private: [], outside: [], hosts: [], readRuns: [] }, at(5));
      await store.addRunReads('family-2', { classes: ['web'], private: [], outside: [], hosts: [] }, at(5));
      expect(await store.getRunReadsOfRuns(['run-1'])).toEqual([{ key: 'family-1', ownerId: 'owner-1', fpKey: 'fp-1', runs: ['run-1'], classes: [], private: [], outside: [], hosts: [], lastReadAt: at(1) }]);
      expect(await store.getRunReadsOfRuns([])).toEqual([]);
    });

    it('hands back copies of what was read, so changing them changes nothing stored', async () => {
      const store = await make();
      const opened = await store.openRunReads('family-1', 'owner-1', 'run-1', 'fp-1', at(1));
      opened.runs.push('run-x');
      const [found] = await store.getRunReadsOfRuns(['run-1']);
      found!.hosts.push('example.com');
      expect((await store.getRunReadsOfRuns(['run-1']))[0]).toMatchObject({ runs: ['run-1'], hosts: [] });
    });

    it('finds the families any of the named runs belong to', async () => {
      const store = await make();
      await store.openRunReads('family-1', 'owner-1', 'run-1', 'fp-1', at(1));
      await store.openRunReads('family-2', 'owner-1', 'run-2', 'fp-1', at(1));
      await store.openRunReads('family-3', 'owner-1', 'run-3', 'fp-1', at(1));
      expect((await store.getRunReadsOfRuns(['run-1', 'run-3', 'never'])).map((reads) => reads.key).sort()).toEqual(['family-1', 'family-3']);
    });
  });

  describe('poisoning signals', () => {
    it('records a signal once and says whether it was new', async () => {
      const store = await make();
      expect(await store.savePoisoningSignal(signal('s1'))).toBe(true);
      expect(await store.savePoisoningSignal(signal('s1', { said: 'changed' }))).toBe(false);
      expect(await store.getPoisoningSignal('owner-1', 's1')).toEqual(signal('s1'));
      expect(await store.getPoisoningSignal('owner-2', 's1')).toBeUndefined();
      expect(await store.getPoisoningSignal('owner-1', 'never')).toBeUndefined();
    });

    it('lists the owner\'s signals newest first, by state and by run when asked', async () => {
      const store = await make();
      await store.savePoisoningSignal(signal('s1', { at: at(1) }));
      await store.savePoisoningSignal(signal('s3', { at: at(3), runId: 'run-2', state: 'dismissed' }));
      await store.savePoisoningSignal(signal('s2', { at: at(2) }));
      await store.savePoisoningSignal(signal('s4', { at: at(4), ownerId: 'owner-2' }));
      expect((await store.getPoisoningSignals('owner-1')).map((found) => found.id)).toEqual(['s3', 's2', 's1']);
      expect((await store.getPoisoningSignals('owner-1', { state: 'open' })).map((found) => found.id)).toEqual(['s2', 's1']);
      expect((await store.getPoisoningSignals('owner-1', { runIds: ['run-2'] })).map((found) => found.id)).toEqual(['s3']);
      expect(await store.getPoisoningSignals('owner-1', { runIds: [] })).toEqual([]);
    });

    it('changes a signal\'s state for its owner only, keeping why it was dismissed when given', async () => {
      const store = await make();
      await store.savePoisoningSignal(signal('s1'));
      expect(await store.setPoisoningSignalState('owner-2', 's1', 'dismissed', 'not mine')).toBe(false);
      expect(await store.setPoisoningSignalState('owner-1', 'never', 'dismissed')).toBe(false);
      expect(await store.setPoisoningSignalState('owner-1', 's1', 'dismissed', 'a test page')).toBe(true);
      expect(await store.getPoisoningSignal('owner-1', 's1')).toMatchObject({ state: 'dismissed', dismissedBecause: 'a test page' });
      expect(await store.setPoisoningSignalState('owner-1', 's1', 'resolved')).toBe(true);
      expect(await store.getPoisoningSignal('owner-1', 's1')).toMatchObject({ state: 'resolved', dismissedBecause: 'a test page' });
    });

    it('nudges whoever listens as each signal is recorded, so they read the signals nobody was told of yet', async () => {
      const store = await make();
      let nudged!: () => void;
      const recorded = new Promise<void>((resolve) => { nudged = resolve; });
      const watching = store.watchPoisoningSignals(() => nudged());
      await watching.ready;
      await store.savePoisoningSignal(signal('s1'));
      await recorded;
      expect((await store.getUntoldPoisoningSignals()).map((found) => found.id)).toEqual(['s1']);
      await watching.close();
    });

    it('lists every signal nobody was told of yet, oldest first, until it is marked told', async () => {
      const store = await make();
      await store.savePoisoningSignal(signal('s2', { at: at(2), ownerId: 'owner-2' }));
      await store.savePoisoningSignal(signal('s1', { at: at(1) }));
      await store.savePoisoningSignal(signal('s0', { at: at(0), toldAt: at(0) }));
      expect((await store.getUntoldPoisoningSignals()).map((found) => found.id)).toEqual(['s1', 's2']);
      await store.markPoisoningSignalTold('s1', at(5));
      expect((await store.getUntoldPoisoningSignals()).map((found) => found.id)).toEqual(['s2']);
      expect(await store.getPoisoningSignal('owner-1', 's1')).toMatchObject({ toldAt: at(5) });
    });
  });

  describe('the crawl corpus and frontier', () => {
    it('keeps pages, replacing one saved again, and finds them by owner, ingest and project', async () => {
      const store = await make();
      await store.saveCorpusPages([page('p1'), page('p2', { projectId: 'project-1' }), page('p3', { ingestId: 'ingest-2' }), page('p4', { ownerId: 'owner-2' })]);
      await store.saveCorpusPages([page('p1', { text: 'newer' })]);
      await store.saveCorpusPages([]);
      expect((await store.getCorpusPages({ ownerId: 'owner-1' })).map((found) => found.id).sort()).toEqual(['p1', 'p2', 'p3']);
      expect((await store.getCorpusPages({ ownerId: 'owner-1', ingestId: 'ingest-1' })).map((found) => found.id).sort()).toEqual(['p1', 'p2']);
      expect(await store.getCorpusPages({ ownerId: 'owner-1', projectId: 'project-1' })).toEqual([page('p2', { projectId: 'project-1' })]);
      expect((await store.getCorpusPages({ ownerId: 'owner-1', ingestId: 'ingest-1' })).find((found) => found.id === 'p1')?.text).toBe('newer');
    });

    it('deletes an ingest\'s pages whoever owns them', async () => {
      const store = await make();
      await store.saveCorpusPages([page('p1'), page('p2', { ownerId: 'owner-2' }), page('p3', { ingestId: 'ingest-2' })]);
      await store.deleteCorpus('ingest-1');
      expect(await store.getCorpusPages({ ownerId: 'owner-2' })).toEqual([]);
      expect((await store.getCorpusPages({ ownerId: 'owner-1' })).map((found) => found.id)).toEqual(['p3']);
    });

    it('queues each address once and counts only those it added', async () => {
      const store = await make();
      expect(await store.enqueueFrontier([frontierUrl('i1', 'https://a.example', 0, 0), frontierUrl('i1', 'https://b.example', 1, 0)])).toBe(2);
      expect(await store.enqueueFrontier([frontierUrl('i1', 'https://b.example', 1, 0), frontierUrl('i1', 'https://c.example', 1, 0), frontierUrl('i1', 'https://c.example', 1, 0)])).toBe(1);
      expect(await store.enqueueFrontier([frontierUrl('i1', 'https://a.example', 0, 0)])).toBe(0);
      expect(await store.enqueueFrontier([])).toBe(0);
      expect(await store.countFrontier('i1')).toBe(3);
    });

    it('hands out pending addresses shallowest first, best ranked first, then by address, without taking them', async () => {
      const store = await make();
      await store.enqueueFrontier([
        frontierUrl('i1', 'https://deep.example', 2, 9),
        frontierUrl('i1', 'https://b.example', 1, 1),
        frontierUrl('i1', 'https://a.example', 1, 1),
        frontierUrl('i1', 'https://ranked.example', 1, 5),
        frontierUrl('i1', 'https://root.example', 0, 0),
        frontierUrl('i2', 'https://other.example', 0, 0),
      ]);
      expect(await store.claimFrontier('i1', 4)).toEqual([
        { url: 'https://root.example', depth: 0 },
        { url: 'https://ranked.example', depth: 1 },
        { url: 'https://a.example', depth: 1 },
        { url: 'https://b.example', depth: 1 },
      ]);
      expect(await store.claimFrontier('i1', 0)).toEqual([]);
      expect(await store.countFrontier('i1')).toBe(5);
    });

    it('stops handing out addresses once done, and forgets an ingest\'s frontier when deleted', async () => {
      const store = await make();
      await store.enqueueFrontier([frontierUrl('i1', 'https://a.example', 0, 0), frontierUrl('i1', 'https://b.example', 0, 0), frontierUrl('i2', 'https://a.example', 0, 0)]);
      await store.completeFrontier('i1', ['https://a.example']);
      await store.completeFrontier('i1', []);
      expect(await store.claimFrontier('i1', 10)).toEqual([{ url: 'https://b.example', depth: 0 }]);
      expect(await store.countFrontier('i2')).toBe(1);
      await store.deleteFrontier('i1');
      expect(await store.countFrontier('i1')).toBe(0);
      expect(await store.enqueueFrontier([frontierUrl('i1', 'https://a.example', 0, 0)])).toBe(1);
      expect(await store.countFrontier('i2')).toBe(1);
    });
  });

  describe('built-in and personal definitions', () => {
    it('shows an owner their own and the built-in procedures, and everyone\'s when no owner is named', async () => {
      const store = await make();
      await store.saveProcedure(procedure('chat'));
      await store.saveProcedure(procedure('chat', 'owner-1'));
      await store.saveProcedure(procedure('mine', 'owner-1'));
      await store.saveProcedure(procedure('theirs', 'owner-2'));
      expect(await store.getProcedure('owner-1', 'chat')).toEqual(procedure('chat', 'owner-1'));
      expect(await store.getProcedure('owner-2', 'chat')).toBeUndefined();
      expect(await store.getProcedure('owner-1', 'never')).toBeUndefined();
      expect((await store.getProcedures('owner-1')).map((found) => `${found.ownerId ?? 'builtin'}:${found.id}`).sort()).toEqual(['builtin:chat', 'owner-1:chat', 'owner-1:mine']);
      expect(await store.getProcedures()).toHaveLength(4);
      await store.deleteProcedure('owner-1', 'chat');
      await store.deleteProcedure(undefined, 'chat');
      expect((await store.getProcedures()).map((found) => found.id).sort()).toEqual(['mine', 'theirs']);
    });

    it('shows an owner their own and the built-in agents, keyed by owner and slug', async () => {
      const store = await make();
      await store.saveEnginePersona(persona('koala'));
      await store.saveEnginePersona(persona('koala', 'owner-1'));
      await store.saveEnginePersona({ ...persona('koala', 'owner-1'), version: '2' });
      await store.saveEnginePersona(persona('theirs', 'owner-2'));
      expect((await store.getEnginePersonas('owner-1')).map((found) => `${found.ownerId ?? 'builtin'}:${found.slug}@${found.version}`).sort()).toEqual(['builtin:koala@1', 'owner-1:koala@2']);
      expect(await store.getEnginePersonas()).toHaveLength(3);
      await store.deleteEnginePersona(undefined, 'koala');
      await store.deleteEnginePersona('owner-2', 'theirs');
      expect(await store.getEnginePersonas()).toEqual([{ ...persona('koala', 'owner-1'), version: '2' }]);
    });

    it('shows an owner their own and the built-in tools, keyed by owner and name', async () => {
      const store = await make();
      await store.saveEngineTool(tool('fetch'));
      await store.saveEngineTool(tool('fetch', 'owner-1'));
      await store.saveEngineTool({ ...tool('fetch'), summary: 'changed' });
      await store.saveEngineTool(tool('theirs', 'owner-2'));
      expect(await store.getEngineTools('owner-1')).toEqual(expect.arrayContaining([{ ...tool('fetch'), summary: 'changed' }, tool('fetch', 'owner-1')]));
      expect(await store.getEngineTools('owner-1')).toHaveLength(2);
      expect(await store.getEngineTools()).toHaveLength(3);
      await store.deleteEngineTool('owner-1', 'fetch');
      await store.deleteEngineTool(undefined, 'fetch');
      expect(await store.getEngineTools()).toEqual([tool('theirs', 'owner-2')]);
    });

    it('shows an owner their own and the shared workspace images, keyed by owner and language', async () => {
      const store = await make();
      await store.saveWorkspaceImage(image('node'));
      await store.saveWorkspaceImage(image('python', 'owner-1'));
      await store.saveWorkspaceImage({ ...image('python', 'owner-1'), summary: 'newer' });
      await store.saveWorkspaceImage(image('go', 'owner-2'));
      expect(await store.getWorkspaceImages('owner-1')).toEqual(expect.arrayContaining([image('node'), { ...image('python', 'owner-1'), summary: 'newer' }]));
      expect(await store.getWorkspaceImages('owner-1')).toHaveLength(2);
      expect(await store.getWorkspaceImages()).toHaveLength(3);
      expect(await store.getWorkspaceImages('')).toHaveLength(3);
    });
  });

  describe('a person\'s settings and extensions', () => {
    it('keeps one extension settings and one auto mode settings per person', async () => {
      const store = await make();
      expect(await store.getExtensionSettings('owner-1')).toBeUndefined();
      expect(await store.getAutoModeSettings('owner-1')).toBeUndefined();
      await store.saveExtensionSettings({ ownerId: 'owner-1', disabled: ['odoo'], updatedAt: at(1) });
      await store.saveExtensionSettings({ ownerId: 'owner-1', disabled: ['odoo', 'mcp'], updatedAt: at(2) });
      await store.saveAutoModeSettings({ ownerId: 'owner-1', agents: ['executor'], updatedAt: at(3) });
      expect(await store.getExtensionSettings('owner-1')).toEqual({ ownerId: 'owner-1', disabled: ['odoo', 'mcp'], updatedAt: at(2) });
      expect(await store.getAutoModeSettings('owner-1')).toEqual({ ownerId: 'owner-1', agents: ['executor'], updatedAt: at(3) });
      expect(await store.getExtensionSettings('owner-2')).toBeUndefined();
    });

    it('keeps the extensions a person authored, by owner and id', async () => {
      const store = await make();
      await store.saveAuthoredExtension(extension('crm'));
      await store.saveAuthoredExtension({ ...extension('crm'), title: 'CRM' });
      await store.saveAuthoredExtension(extension('crm', 'owner-2'));
      await store.saveAuthoredExtension(extension('mail'));
      expect(await store.getAuthoredExtensions('owner-1')).toEqual(expect.arrayContaining([{ ...extension('crm'), title: 'CRM' }, extension('mail')]));
      expect(await store.getAuthoredExtensions('owner-1')).toHaveLength(2);
      await store.deleteAuthoredExtension('owner-1', 'crm');
      expect(await store.getAuthoredExtensions('owner-1')).toEqual([extension('mail')]);
      expect(await store.getAuthoredExtensions('owner-2')).toEqual([extension('crm', 'owner-2')]);
    });
  });

  describe('MCP requests, hints and action proposals', () => {
    it('lists the owner\'s MCP requests oldest first, in one conversation when named', async () => {
      const store = await make();
      await store.saveMcpRequest(mcpRequest('r2', { createdAt: at(2) }));
      await store.saveMcpRequest(mcpRequest('r1', { createdAt: at(1), conversationId: 'chat-2' }));
      await store.saveMcpRequest(mcpRequest('r3', { createdAt: at(3), ownerId: 'owner-2' }));
      await store.saveMcpRequest(mcpRequest('r2', { createdAt: at(2), status: 'enabled' }));
      expect((await store.getMcpRequests('owner-1')).map((found) => found.id)).toEqual(['r1', 'r2']);
      expect(await store.getMcpRequests('owner-1', 'chat-1')).toEqual([mcpRequest('r2', { createdAt: at(2), status: 'enabled' })]);
      expect(await store.getMcpRequest('owner-1', 'r1')).toEqual(mcpRequest('r1', { createdAt: at(1), conversationId: 'chat-2' }));
      expect(await store.getMcpRequest('owner-2', 'r1')).toBeUndefined();
    });

    it('has no MCP tool hints to give, and forgetting one changes nothing', async () => {
      const store = await make();
      await store.deleteMcpToolHint('owner-1', 'github', 'create_issue');
      expect(await store.getMcpToolHints('owner-1')).toEqual([]);
    });

    it('lists the owner\'s action proposals oldest first, by conversation and tree when named', async () => {
      const store = await make();
      await store.saveActionProposal(proposal('a3', { createdAt: at(3), conversationId: 'chat-1', treeId: 'tree-1' }));
      await store.saveActionProposal(proposal('a1', { createdAt: at(1), conversationId: 'chat-1' }));
      await store.saveActionProposal(proposal('a2', { createdAt: at(2), treeId: 'tree-1' }));
      await store.saveActionProposal(proposal('a4', { createdAt: at(4), ownerId: 'owner-2', conversationId: 'chat-1' }));
      expect((await store.getActionProposals('owner-1')).map((found) => found.id)).toEqual(['a1', 'a2', 'a3']);
      expect((await store.getActionProposals('owner-1', { conversationId: 'chat-1' })).map((found) => found.id)).toEqual(['a1', 'a3']);
      expect((await store.getActionProposals('owner-1', { treeId: 'tree-1' })).map((found) => found.id)).toEqual(['a2', 'a3']);
      expect((await store.getActionProposals('owner-1', { conversationId: 'chat-1', treeId: 'tree-1' })).map((found) => found.id)).toEqual(['a3']);
      await store.saveActionProposal(proposal('a1', { createdAt: at(1), conversationId: 'chat-1', status: 'applied' }));
      expect(await store.getActionProposal('owner-1', 'a1')).toEqual(proposal('a1', { createdAt: at(1), conversationId: 'chat-1', status: 'applied' }));
      expect(await store.getActionProposal('owner-2', 'a1')).toBeUndefined();
    });
  });

  describe('published workspaces, MCP servers and workspace dependencies', () => {
    it('keeps one published workspace per owner and tree', async () => {
      const store = await make();
      await store.savePublishedWorkspace(published('tree-1'));
      await store.savePublishedWorkspace({ ...published('tree-1'), image: 'registry/tree-1:2' });
      await store.savePublishedWorkspace(published('tree-2'));
      await store.savePublishedWorkspace(published('tree-1', 'owner-2'));
      expect(await store.getPublishedWorkspace('owner-1', 'tree-1')).toEqual({ ...published('tree-1'), image: 'registry/tree-1:2' });
      expect(await store.getPublishedWorkspace('owner-1', 'never')).toBeUndefined();
      expect((await store.getPublishedWorkspaces('owner-1')).map((found) => found.treeId).sort()).toEqual(['tree-1', 'tree-2']);
      await store.deletePublishedWorkspace('owner-1', 'tree-1');
      expect(await store.getPublishedWorkspace('owner-1', 'tree-1')).toBeUndefined();
      expect(await store.getPublishedWorkspace('owner-2', 'tree-1')).toEqual(published('tree-1', 'owner-2'));
    });

    it('lists the owner\'s MCP servers by name and forgets one when deleted', async () => {
      const store = await make();
      await store.saveMcpServer(server('s1', 'playwright'));
      await store.saveMcpServer(server('s2', 'github'));
      await store.saveMcpServer(server('s3', 'Zed'));
      await store.saveMcpServer(server('s4', 'another', 'owner-2'));
      await store.saveMcpServer({ ...server('s1', 'playwright'), notes: 'for browser checks' });
      expect((await store.getMcpServers('owner-1')).map((found) => found.name)).toEqual(['Zed', 'github', 'playwright']);
      expect((await store.getMcpServers('owner-1'))[2]).toEqual({ ...server('s1', 'playwright'), notes: 'for browser checks' });
      await store.deleteMcpServer('owner-1', 's2');
      expect((await store.getMcpServers('owner-1')).map((found) => found.id)).toEqual(['s3', 's1']);
    });

    it('lists the owner\'s workspace dependencies by name and forgets one when deleted', async () => {
      const store = await make();
      await store.saveWorkspaceDependency(dependency('jq'));
      await store.saveWorkspaceDependency(dependency('chromium'));
      await store.saveWorkspaceDependency({ ...dependency('jq'), summary: 'newer' });
      await store.saveWorkspaceDependency(dependency('go', 'owner-2'));
      expect(await store.getWorkspaceDependencies('owner-1')).toEqual([dependency('chromium'), { ...dependency('jq'), summary: 'newer' }]);
      await store.deleteWorkspaceDependency('owner-1', 'jq');
      expect((await store.getWorkspaceDependencies('owner-1')).map((found) => found.name)).toEqual(['chromium']);
    });
  });

  describe('tool grants', () => {
    it('lists the owner\'s grants by when they were granted, those with no time first', async () => {
      const store = await make();
      await store.saveToolGrant(toolGrant('koala', 'b-tool', { grantedAt: at(2) }));
      await store.saveToolGrant(toolGrant('koala', 'a-tool', { grantedAt: at(2) }));
      await store.saveToolGrant(toolGrant('research', 'z-tool'));
      await store.saveToolGrant(toolGrant('koala', 'c-tool', { grantedAt: at(1) }));
      await store.saveToolGrant(toolGrant('koala', 'other', { ownerId: 'owner-2' }));
      expect((await store.getToolGrants('owner-1')).map((found) => found.tool)).toEqual(['z-tool', 'c-tool', 'a-tool', 'b-tool']);
    });

    it('keeps a server grant apart from a tool grant of the same name', async () => {
      const store = await make();
      await store.saveToolGrant(toolGrant('koala', 'github'));
      await store.saveToolGrant(toolGrant('koala', 'github', { kind: 'server' }));
      await store.saveToolGrant(toolGrant('koala', 'github', { kind: 'tool', revoked: true }));
      expect(await store.getToolGrants('owner-1')).toEqual(expect.arrayContaining([toolGrant('koala', 'github', { kind: 'tool', revoked: true }), toolGrant('koala', 'github', { kind: 'server' })]));
      expect(await store.getToolGrants('owner-1')).toHaveLength(2);
      await store.deleteToolGrant('owner-1', 'koala', 'github', 'server');
      expect(await store.getToolGrants('owner-1')).toEqual([toolGrant('koala', 'github', { kind: 'tool', revoked: true })]);
      await store.deleteToolGrant('owner-1', 'koala', 'github');
      expect(await store.getToolGrants('owner-1')).toEqual([]);
    });

    it('deletes the grants that match an agent, a tool and a kind, for one owner or all, and counts them', async () => {
      const store = await make();
      await store.saveToolGrant(toolGrant('koala', 'fetch'));
      await store.saveToolGrant(toolGrant('koala', 'github', { kind: 'server' }));
      await store.saveToolGrant(toolGrant('research', 'fetch', { kind: 'tool' }));
      await store.saveToolGrant(toolGrant('koala', 'fetch', { ownerId: 'owner-2' }));
      await store.saveToolGrant(toolGrant('koala', 'github', { ownerId: 'owner-2', kind: 'server' }));
      expect(await store.deleteToolGrantsFor('owner-1', { agent: 'koala', kind: 'tool' })).toBe(1);
      expect(await store.deleteToolGrantsFor(undefined, { tool: 'github', kind: 'server' })).toBe(2);
      expect(await store.deleteToolGrantsFor('owner-1', { tool: 'fetch' })).toBe(1);
      expect(await store.getToolGrants('owner-1')).toEqual([]);
      expect(await store.deleteToolGrantsFor(undefined, {})).toBe(1);
      expect(await store.getToolGrants('owner-2')).toEqual([]);
    });
  });
}

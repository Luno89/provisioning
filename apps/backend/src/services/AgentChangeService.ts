import type { EvalRecordStore } from '../lib/eval-run.js';
import { handoffMessage, type AgentChange, type PromptChange, type PromptComparison } from '../lib/agent-changes.js';

export type AcceptChangeOutcome =
  | { accepted: true; change: AgentChange }
  | { accepted: false; status: 400 | 404 | 409; problems: string[] };

export class AgentChangeService {
  constructor(private readonly deps: {
    store: EvalRecordStore;
    savePrompt: (ownerId: string, agent: string, prompt: string) => Promise<{ saved: true } | { saved: false; problems: string[] }>;
    handOff: (ownerId: string, message: string) => Promise<{ conversationId: string; runId: string }>;
    now?: () => string;
  }) {}

  private now(): string {
    return this.deps.now?.() ?? new Date().toISOString();
  }

  async list(ownerId: string): Promise<AgentChange[]> {
    const all = await this.deps.store.getEvalRecords<AgentChange>('evalAgentChanges', ownerId, 1000);
    return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private async find(ownerId: string, id: string): Promise<AgentChange | undefined> {
    return (await this.deps.store.getEvalRecord<AgentChange>('evalAgentChanges', ownerId, id)) ?? undefined;
  }

  async pending(ownerId: string): Promise<PromptChange[]> {
    return (await this.list(ownerId)).filter((change): change is PromptChange => change.kind === 'prompt' && change.status === 'proposed');
  }

  async comparing(ownerId: string, id: string): Promise<void> {
    const change = await this.find(ownerId, id);
    if (change?.kind === 'prompt' && change.status === 'proposed') await this.deps.store.saveEvalRecord('evalAgentChanges', { ...change, status: 'comparing' });
  }

  async settle(ownerId: string, id: string, comparison: PromptComparison): Promise<PromptChange | undefined> {
    const change = await this.find(ownerId, id);
    if (change?.kind !== 'prompt' || (change.status !== 'comparing' && change.status !== 'proposed')) return undefined;
    const ready: PromptChange = { ...change, status: 'ready', comparison };
    await this.deps.store.saveEvalRecord('evalAgentChanges', ready);
    return ready;
  }

  async accept(ownerId: string, id: string, edited?: unknown): Promise<AcceptChangeOutcome> {
    const change = await this.find(ownerId, id);
    if (!change || change.kind !== 'prompt') return { accepted: false, status: 404, problems: ['there is no prompt change with that id'] };
    if (change.status !== 'ready') return { accepted: false, status: 409, problems: [`it is ${change.status}; a prompt change is accepted once the bench has compared it`] };
    const prompt = typeof edited === 'string' && edited.trim() ? edited.trim() : change.prompt;
    const saved = await this.deps.savePrompt(ownerId, change.agent, prompt);
    if (!saved.saved) return { accepted: false, status: 400, problems: saved.problems };
    const accepted: AgentChange = { ...change, prompt, status: 'accepted', decidedAt: this.now() };
    await this.deps.store.saveEvalRecord('evalAgentChanges', accepted);
    return { accepted: true, change: accepted };
  }

  async handOver(ownerId: string, id: string): Promise<AcceptChangeOutcome> {
    const change = await this.find(ownerId, id);
    if (!change || change.kind !== 'procedure') return { accepted: false, status: 404, problems: ['there is no procedure request with that id'] };
    if (change.status !== 'proposed') return { accepted: false, status: 409, problems: [`it is already ${change.status}`] };
    const { conversationId, runId } = await this.deps.handOff(ownerId, handoffMessage(change));
    const handed: AgentChange = { ...change, status: 'handed-over', conversationId, runId, decidedAt: this.now() };
    await this.deps.store.saveEvalRecord('evalAgentChanges', handed);
    return { accepted: true, change: handed };
  }

  async dismiss(ownerId: string, id: string): Promise<boolean> {
    const change = await this.find(ownerId, id);
    if (!change || !['proposed', 'comparing', 'ready'].includes(change.status)) return false;
    await this.deps.store.saveEvalRecord('evalAgentChanges', { ...change, status: 'dismissed', decidedAt: this.now() });
    return true;
  }
}

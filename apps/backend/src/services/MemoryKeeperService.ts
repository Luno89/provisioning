import type { Conversation } from '../lib/conversations.js';
import type { Branch, Leaf } from '../lib/leaves.js';
import {
  DEFAULT_CONCLUDE_AFTER_MINUTES,
  LEAF_JUDGE,
  MEMORY_KEEPER,
  conversationConclusion,
  conversationWatermarkKey,
  leafConclusion,
  runConclusion,
  type Conclusion,
} from '../lib/conclusions.js';
import type { LifecycleEvent } from '../engine-host/temporal/contracts.js';

export interface MemoryKeeperStore {
  getConversation(ownerId: string, id: string): Promise<Conversation | undefined>;
  getLeaves(): Promise<Leaf[]>;
  getBranches(): Promise<Branch[]>;
  getMemoryWatermark(key: string): Promise<string | undefined>;
  saveMemoryWatermark(key: string, value: string): Promise<void>;
}

export type StartMemoryRun = (request: {
  ownerId: string;
  agentSlug: string;
  message: string;
  runId: string;
  bound?: Record<string, string> | undefined;
}) => Promise<void>;

export type ConversationTimer = (request: {
  ownerId: string;
  conversationId: string;
  signal: 'turnStarted' | 'turnEnded';
  quietMs?: number | undefined;
}) => Promise<void>;

export interface ConclusionReport {
  started: string[];
}


export class MemoryKeeperService {
  constructor(private readonly deps: {
    store: MemoryKeeperStore;
    start: StartMemoryRun;
    timer: ConversationTimer;
    concludeAfterMinutes: (ownerId: string, agentSlug: string) => Promise<number | undefined>;
    remembersFor?: ((ownerId: string) => Promise<boolean>) | undefined;
  }) {}

  async handle(event: LifecycleEvent): Promise<ConclusionReport> {
    const report: ConclusionReport = { started: [] };

    if (event.kind === 'run-started') {
      if (event.conversationId && event.agentSlug !== MEMORY_KEEPER) {
        await this.deps.timer({ ownerId: event.ownerId, conversationId: event.conversationId, signal: 'turnStarted' });
      }
      return report;
    }

    if (event.kind === 'conversation-quiet') {
      await this.concludeConversation(event.ownerId, event.conversationId, 'quiet', report);
      return report;
    }

    if (event.conversationId && event.depth === 0 && event.agentSlug !== MEMORY_KEEPER) {
      const minutes = (await this.deps.concludeAfterMinutes(event.ownerId, event.agentSlug)) ?? DEFAULT_CONCLUDE_AFTER_MINUTES;
      await this.deps.timer({ ownerId: event.ownerId, conversationId: event.conversationId, signal: 'turnEnded', quietMs: minutes * 60_000 });
    }

    const fromRun = runConclusion(event);
    if (fromRun) await this.begin(fromRun, report);

    if (event.agentSlug === LEAF_JUDGE && event.outcome === 'ok' && event.leafId) {
      const leaf = (await this.deps.store.getLeaves()).find((entry) => entry.id === event.leafId && entry.ownerId === event.ownerId);
      const treeId = leaf ? (await this.deps.store.getBranches()).find((branch) => branch.id === leaf.branchId)?.treeId : undefined;
      const fromLeaf = leaf ? leafConclusion(leaf, treeId) : undefined;
      if (fromLeaf) await this.begin(fromLeaf, report);
    }

    return report;
  }

  async settled(ownerId: string, conversationId: string | undefined): Promise<ConclusionReport> {
    const report: ConclusionReport = { started: [] };
    if (conversationId) await this.concludeConversation(ownerId, conversationId, 'settled', report);
    return report;
  }

  private async concludeConversation(ownerId: string, conversationId: string, why: 'quiet' | 'settled', report: ConclusionReport): Promise<void> {
    const conversation = await this.deps.store.getConversation(ownerId, conversationId);
    if (!conversation || conversation.agentSlug === MEMORY_KEEPER) return;
    const key = conversationWatermarkKey(conversation.id);
    const through = Number(await this.deps.store.getMemoryWatermark(key)) || 0;
    const conclusion = conversationConclusion(conversation, through, why);
    if (!conclusion) return;
    await this.begin(conclusion, report);
    await this.deps.store.saveMemoryWatermark(key, String(conversation.messages.length));
  }

  private async begin(conclusion: Conclusion, report: ConclusionReport): Promise<void> {
    if (this.deps.remembersFor && !(await this.deps.remembersFor(conclusion.ownerId))) return;
    try {
      await this.deps.start({
        ownerId: conclusion.ownerId,
        agentSlug: MEMORY_KEEPER,
        message: conclusion.message,
        runId: conclusion.runId,
        bound: {
          ...(conclusion.projectId ? { projectId: conclusion.projectId } : {}),
          ...(conclusion.treeId ? { treeId: conclusion.treeId } : {}),
        },
      });
    } catch (err) {
      if (!/already started|AlreadyStarted/i.test((err as Error).message)) throw err;
    }
    report.started.push(conclusion.runId);
  }
}

import type { Conversation } from '../../engine/lib/conversations.js';
import type { Branch, Leaf } from '../../projects/lib/leaves.js';
import {
  DEFAULT_CONCLUDE_AFTER_MINUTES,
  LEAF_JUDGE,
  MEMORY_KEEPER,
  conversationConclusion,
  conversationWatermarkKey,
  leafConclusion,
  runConclusion,
  type Conclusion,
  type DeferredConclusion,
  type KeeperSettings,
} from '../lib/conclusions.js';
import type { LifecycleEvent } from '../../engine-host/temporal/contracts.js';

export interface MemoryKeeperStore {
  engine: {
    getConversation(ownerId: string, id: string): Promise<Conversation | undefined>;
  };
  projects: {
    getLeaves(): Promise<Leaf[]>;
    getBranches(): Promise<Branch[]>;
  };
  memory: {
    getMemoryWatermark(key: string): Promise<string | undefined>;
    saveMemoryWatermark(key: string, value: string): Promise<void>;
    getKeeperSettings(ownerId: string): Promise<KeeperSettings | undefined>;
    saveKeeperSettings(settings: KeeperSettings): Promise<void>;
    getDeferredConclusions(ownerId: string): Promise<DeferredConclusion[]>;
    saveDeferredConclusion(deferred: DeferredConclusion): Promise<void>;
    deleteDeferredConclusion(ownerId: string, id: string): Promise<void>;
  };
}

export type StartMemoryRun = (request: {
  ownerId: string;
  agentSlug: string;
  message: string;
  runId: string;
  about?: string | undefined;
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
  deferred?: string[] | undefined;
}

export interface KeeperState {
  paused: boolean;
  held: number;
}


export class MemoryKeeperService {
  constructor(private readonly deps: {
    store: MemoryKeeperStore;
    start: StartMemoryRun;
    timer: ConversationTimer;
    concludeAfterMinutes: (ownerId: string, agentSlug: string) => Promise<number | undefined>;
    remembersFor?: ((ownerId: string) => Promise<boolean>) | undefined;
    now?: (() => string) | undefined;
  }) {}

  private now(): string {
    return this.deps.now?.() ?? new Date().toISOString();
  }

  async state(ownerId: string): Promise<KeeperState> {
    const [settings, held] = await Promise.all([this.deps.store.memory.getKeeperSettings(ownerId), this.deps.store.memory.getDeferredConclusions(ownerId)]);
    return { paused: settings?.paused === true, held: held.length };
  }

  async setPaused(ownerId: string, paused: boolean): Promise<KeeperState & { started: string[] }> {
    await this.deps.store.memory.saveKeeperSettings({ ownerId, paused, updatedAt: this.now() });
    const report: ConclusionReport = { started: [] };
    if (!paused) {
      for (const deferred of await this.deps.store.memory.getDeferredConclusions(ownerId)) {
        await this.startNow(deferred.conclusion, report);
        await this.deps.store.memory.deleteDeferredConclusion(ownerId, deferred.id);
      }
    }
    return { ...(await this.state(ownerId)), started: report.started };
  }

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
      const leaf = (await this.deps.store.projects.getLeaves()).find((entry) => entry.id === event.leafId && entry.ownerId === event.ownerId);
      const treeId = leaf ? (await this.deps.store.projects.getBranches()).find((branch) => branch.id === leaf.branchId)?.treeId : undefined;
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
    const conversation = await this.deps.store.engine.getConversation(ownerId, conversationId);
    if (!conversation || conversation.agentSlug === MEMORY_KEEPER) return;
    const key = conversationWatermarkKey(conversation.id);
    const through = Number(await this.deps.store.memory.getMemoryWatermark(key)) || 0;
    const conclusion = conversationConclusion(conversation, through, why);
    if (!conclusion) return;
    await this.begin(conclusion, report);
    await this.deps.store.memory.saveMemoryWatermark(key, String(conversation.messages.length));
  }

  private async begin(conclusion: Conclusion, report: ConclusionReport): Promise<void> {
    if (this.deps.remembersFor && !(await this.deps.remembersFor(conclusion.ownerId))) return;
    if ((await this.deps.store.memory.getKeeperSettings(conclusion.ownerId))?.paused) {
      await this.deps.store.memory.saveDeferredConclusion({ id: conclusion.runId, ownerId: conclusion.ownerId, conclusion, at: this.now() });
      report.deferred = [...(report.deferred ?? []), conclusion.runId];
      return;
    }
    await this.startNow(conclusion, report);
  }

  private async startNow(conclusion: Conclusion, report: ConclusionReport): Promise<void> {
    try {
      await this.deps.start({
        ownerId: conclusion.ownerId,
        agentSlug: MEMORY_KEEPER,
        message: conclusion.message,
        runId: conclusion.runId,
        ...(conclusion.about ? { about: conclusion.about } : {}),
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

import type { EngineStore } from '../store.js';
import type { MemoryItem } from '../../memory/index.js';
import {
  memoryFromHost, memoryFromRun, serious, tellingOf, worstFirst,
  type PoisoningSignal, type RetireScope, type SignalView,
} from '../lib/poisoning.js';

export interface PoisoningServiceDeps {
  store: Pick<EngineStore, 'getPoisoningSignals' | 'getPoisoningSignal' | 'setPoisoningSignalState' | 'getUntoldPoisoningSignals' | 'markPoisoningSignalTold' | 'getRunReadsOfRuns'>;
  memories: { list(ownerId: string): Promise<MemoryItem[]>; save(item: MemoryItem): Promise<void> };
  unseal(sealed: string): string;
  push?: ((ownerId: string, message: { title: string; body: string; path: string; tag: string }) => Promise<unknown>) | undefined;
  mail?: ((ownerId: string, message: { subject: string; text: string }) => Promise<unknown>) | undefined;
  now?: (() => string) | undefined;
  log?: ((message: string) => void) | undefined;
}

export class PoisoningError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export class PoisoningService {
  constructor(private readonly deps: PoisoningServiceDeps) {}

  private now(): string {
    return (this.deps.now ?? (() => new Date().toISOString()))();
  }

  private unsealed(sealed: string | undefined): string | undefined {
    if (!sealed) return undefined;
    try {
      return this.deps.unseal(sealed);
    } catch {
      return undefined;
    }
  }

  private view(signal: PoisoningSignal): SignalView {
    const matched = this.unsealed(signal.sealedMatch);
    return {
      id: signal.id,
      kind: signal.kind,
      severity: signal.severity,
      state: signal.state,
      at: signal.at,
      runId: signal.runId,
      tool: signal.tool,
      said: signal.said,
      ...(signal.agentSlug ? { agentSlug: signal.agentSlug } : {}),
      ...(matched ? { matched } : {}),
      ...(signal.host ? { host: signal.host } : {}),
      ...(signal.path ? { path: signal.path } : {}),
      ...(signal.conversationId ? { conversationId: signal.conversationId } : {}),
      ...(signal.projectId ? { projectId: signal.projectId } : {}),
      ...(signal.dismissedBecause ? { dismissedBecause: signal.dismissedBecause } : {}),
    };
  }

  async list(ownerId: string, filter: { open?: boolean; runIds?: readonly string[] } = {}): Promise<SignalView[]> {
    const signals = await this.deps.store.getPoisoningSignals(ownerId, { ...(filter.open ? { state: 'open' as const } : {}), ...(filter.runIds ? { runIds: filter.runIds } : {}) });
    return worstFirst(signals).map((signal) => this.view(signal));
  }

  private async signal(ownerId: string, id: string): Promise<PoisoningSignal> {
    const signal = await this.deps.store.getPoisoningSignal(ownerId, id);
    if (!signal) throw new PoisoningError(404, 'there is no such finding');
    return signal;
  }

  async dismiss(ownerId: string, id: string, because?: string | undefined): Promise<SignalView> {
    const signal = await this.signal(ownerId, id);
    const reason = because?.trim().slice(0, 500) || undefined;
    await this.deps.store.setPoisoningSignalState(ownerId, id, 'dismissed', reason);
    return this.view({ ...signal, state: 'dismissed', ...(reason ? { dismissedBecause: reason } : {}) });
  }

  async retire(ownerId: string, id: string, scope: RetireScope): Promise<{ retired: number; signal: SignalView }> {
    const signal = await this.signal(ownerId, id);
    if (scope === 'source' && !signal.host) throw new PoisoningError(409, 'this finding names no host, so there is no source to retire everything from; retire what its run left instead');
    const [family] = await this.deps.store.getRunReadsOfRuns([signal.runId]);
    const runs = new Set(family?.runs ?? [signal.runId]);
    const at = this.now();
    const why = scope === 'run' ? `retired with what run ${signal.runId} left, after Koala noticed: ${signal.said}` : `retired with everything learned from ${signal.host}, after Koala noticed: ${signal.said}`;
    const current = (await this.deps.memories.list(ownerId)).filter((memory) => memory.ownerId === ownerId && !memory.invalidAt);
    const retiring = current.filter((memory) => (scope === 'run' ? memoryFromRun(memory, runs) : memoryFromHost(memory, signal.host!)));
    for (const memory of retiring) await this.deps.memories.save({ ...memory, invalidAt: at, updatedAt: at, text: `${memory.text}\n(${why})` });
    await this.deps.store.setPoisoningSignalState(ownerId, id, 'resolved');
    return { retired: retiring.length, signal: this.view({ ...signal, state: 'resolved' }) };
  }

  async tellNew(): Promise<number> {
    let told = 0;
    for (const signal of await this.deps.store.getUntoldPoisoningSignals()) {
      if (serious(signal.severity)) {
        const telling = tellingOf(signal);
        await this.deps.push?.(signal.ownerId, { title: telling.subject, body: signal.said, path: telling.path, tag: `poisoning-${signal.id}` })
          .catch((error: Error) => (this.deps.log ?? console.warn)(`[poisoning] could not push ${signal.id}: ${error.message}`));
        await this.deps.mail?.(signal.ownerId, { subject: telling.subject, text: telling.text })
          .catch((error: Error) => (this.deps.log ?? console.warn)(`[poisoning] could not email ${signal.id}: ${error.message}`));
        told += 1;
      }
      await this.deps.store.markPoisoningSignalTold(signal.id, this.now());
    }
    return told;
  }
}

import { randomBytes } from 'crypto';
import { canaryFor } from '@koala/agent-engine/procedure';
import { koalaMetrics } from '@koala/engine-core/telemetry';
import type { ToolOutcome } from '@koala/engine-core';
import type { ToolCallArgs } from '../temporal/contracts.js';
import type { EngineStore, SourceClass } from '../../engine/index.js';
import {
  SEVERITY_OF, findingsOf, hiddenInRepo, readsOf, rememberedOf, runReadBy, signalId,
  type CallFinding, type PoisoningSignal, type ReadElsewhere, type RunReads,
} from '../../engine/lib/poisoning.js';

export interface PoisoningWatchDeps {
  store: Pick<EngineStore, 'openRunReads' | 'addRunReads' | 'getRunReadsOfRuns' | 'savePoisoningSignal'>;
  personText(ownerId: string, conversationId: string | undefined): Promise<string>;
  seal(text: string): string;
  now?: (() => string) | undefined;
  log?: ((message: string) => void) | undefined;
}

export const readsKeyOf = (args: Pick<ToolCallArgs, 'ticket'>): string => args.ticket.grantId ?? args.ticket.runId;

export class PoisoningWatch {
  constructor(private readonly deps: PoisoningWatchDeps) {}

  private now(): string {
    return (this.deps.now ?? (() => new Date().toISOString()))();
  }

  private async reads(args: ToolCallArgs): Promise<RunReads> {
    return this.deps.store.openRunReads(readsKeyOf(args), args.ticket.ownerId, args.ticket.runId, randomBytes(16).toString('hex'), this.now());
  }

  private async record(args: ToolCallArgs, finding: CallFinding): Promise<void> {
    const readsKey = readsKeyOf(args);
    const severity = SEVERITY_OF[finding.kind];
    const signal: PoisoningSignal = {
      id: signalId(readsKey, finding, args.name),
      ownerId: args.ticket.ownerId,
      kind: finding.kind,
      severity,
      state: 'open',
      at: this.now(),
      readsKey,
      runId: args.ticket.runId,
      agentSlug: args.ticket.agentSlug,
      tool: args.name,
      said: finding.said,
      ...(finding.matched ? { sealedMatch: this.deps.seal(finding.matched) } : {}),
      ...(finding.host ? { host: finding.host } : {}),
      ...(finding.path ? { path: finding.path } : {}),
      ...(args.ticket.conversationId ? { conversationId: args.ticket.conversationId } : {}),
      ...(args.ticket.projectId ? { projectId: args.ticket.projectId } : {}),
    };
    if (await this.deps.store.savePoisoningSignal(signal)) koalaMetrics().poisoningSignals.add(1, { kind: finding.kind, severity });
  }

  async beforeCall(args: ToolCallArgs, parsed: Readonly<Record<string, unknown>>, mcp: boolean): Promise<void> {
    try {
      const reads = await this.reads(args);
      const remembering = rememberedOf(args.name, parsed).length > 0;
      const elsewhere: ReadElsewhere[] = remembering && reads.readRuns?.length
        ? (await this.deps.store.getRunReadsOfRuns(reads.readRuns)).filter((other) => other.key !== reads.key)
          .map((other) => ({ key: other.fpKey, outside: new Set(other.outside), classes: new Set(other.classes) }))
        : [];
      const findings = findingsOf({
        tool: args.name,
        rawArguments: args.arguments,
        args: parsed,
        mcp,
        canary: canaryFor(reads.key),
        reads: { key: reads.fpKey, private: new Set(reads.private), outside: new Set(reads.outside), hosts: new Set(reads.hosts), classes: new Set(reads.classes) },
        elsewhere,
        personText: await this.deps.personText(args.ticket.ownerId, args.ticket.conversationId),
      });
      for (const finding of findings) await this.record(args, finding);
    } catch (err) {
      (this.deps.log ?? console.warn)(`[poisoning] could not check ${args.name} in ${args.ticket.runId}: ${(err as Error).message}`);
    }
  }

  async afterCall(args: ToolCallArgs, parsed: Readonly<Record<string, unknown>>, source: SourceClass, outcome: ToolOutcome, hiddenRemoved: number): Promise<void> {
    try {
      const reads = await this.reads(args);
      const part = readsOf(reads.fpKey, source, outcome.content ?? outcome.digest);
      const readRun = runReadBy(args.name, parsed);
      await this.deps.store.addRunReads(reads.key, { ...part, ...(readRun ? { readRuns: [readRun] } : {}) }, this.now());
      const hidden = hiddenInRepo(args.name, source, hiddenRemoved, parsed);
      if (hidden) await this.record(args, hidden);
    } catch (err) {
      (this.deps.log ?? console.warn)(`[poisoning] could not keep what ${args.name} read in ${args.ticket.runId}: ${(err as Error).message}`);
    }
  }
}

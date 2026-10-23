import type { EnvironmentDriver, EnvironmentScope, EnvironmentSpec } from '@koala/engine-core';
import { workspaceStamp } from '../../engine/lib/published-workspace.js';
import type { RunTicket } from '../temporal/contracts.js';
import type { RunWorkspace } from './workspace.js';
import { elapsedSeconds, koalaMetrics, withSpan } from '@koala/engine-core/telemetry';

export interface ProvisionForRun {
  id: string;
  ticket: RunTicket;
  spec: EnvironmentSpec;
  workspace?: RunWorkspace | undefined;
  scope?: EnvironmentScope | undefined;
}

export interface RunEnvironmentOptions {
  provision: (request: ProvisionForRun) => Promise<EnvironmentDriver>;
  ended?: ((runId: string) => Promise<boolean>) | undefined;
  now?: (() => number) | undefined;
  onLeak?: ((id: string, ageMs: number) => void) | undefined;
}

export interface RunEnvironments {
  forRun(request: {
    ticket: RunTicket;
    id?: string | undefined;
    spec: EnvironmentSpec;
    workspace?: RunWorkspace | undefined;
    scope?: EnvironmentScope | undefined;
  }): Promise<EnvironmentDriver>;
  release(runId: string): Promise<boolean>;
  sweep(at?: number): Promise<string[]>;
  live(): number;
}

export function environmentIdFor(runId: string): string {
  const cleaned = runId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  return `engine-${cleaned}`.slice(0, 63).replace(/-$/, '');
}

interface Live {
  driver: EnvironmentDriver;
  startedAt: number;
  owned: boolean;
  runId: string;
  stamp?: string | undefined;
}

export function createRunEnvironments(options: RunEnvironmentOptions): RunEnvironments {
  const now = options.now ?? (() => Date.now());
  const live = new Map<string, Live>();
  const starting = new Map<string, Promise<EnvironmentDriver>>();

  const dispose = async (id: string, entry: Live): Promise<void> => {
    live.delete(id);
    if (entry.owned) await entry.driver.dispose?.().catch(() => undefined);
  };

  return {
    async forRun({ ticket, id, spec, workspace, scope }): Promise<EnvironmentDriver> {
      const own = environmentIdFor(ticket.runId);
      const base = id ?? own;
      const key = scope?.worktree ? `${base}#${scope.worktree}` : base;

      const stamp = workspace ? workspaceStamp(workspace) : undefined;
      const existing = live.get(key);
      if (existing && (stamp === undefined || existing.stamp === undefined || existing.stamp === stamp)) return existing.driver;
      if (existing) live.delete(key);

      const inFlight = starting.get(key);
      if (inFlight) return inFlight;

      const askedAt = Date.now();
      const measure = (outcome: string) => koalaMetrics().sandboxProvisionSeconds.record(elapsedSeconds(askedAt), { outcome, kind: spec.kind });
      const attempt = withSpan('sandbox.provision', { 'koala.run.id': ticket.runId, 'koala.sandbox.kind': spec.kind, 'koala.sandbox.shared': base !== own }, () => options.provision({
        id: base,
        ticket,
        spec,
        ...(workspace ? { workspace } : {}),
        ...(scope ? { scope } : {}),
      })).then((driver) => {
        live.set(key, { driver, startedAt: now(), owned: base === own, runId: ticket.runId, ...(stamp ? { stamp } : {}) });
        starting.delete(key);
        measure('ok');
        return driver;
      }).catch((err: unknown) => {
        starting.delete(key);
        measure('failed');
        throw err;
      });

      starting.set(key, attempt);
      return attempt;
    },

    async release(runId: string): Promise<boolean> {
      const own = environmentIdFor(runId);
      const mine = [...live.entries()].filter(([key]) => key === own || key.startsWith(`${own}#`));
      for (const [key, entry] of mine) await dispose(key, entry);
      return mine.length > 0;
    },

    async sweep(at: number = now()): Promise<string[]> {
      const ended = options.ended;
      if (!ended) return [];
      const entries = [...live.entries()];
      const gone = await Promise.all(entries.map(([, entry]) => ended(entry.runId)));
      const stale = entries.filter((_, index) => gone[index]);

      for (const [id, entry] of stale) {
        if (entry.owned) options.onLeak?.(entry.runId, at - entry.startedAt);
        await dispose(id, entry);
      }

      return stale.filter(([, entry]) => entry.owned).map(([, entry]) => entry.runId);
    },

    live(): number {
      return live.size;
    },
  };
}

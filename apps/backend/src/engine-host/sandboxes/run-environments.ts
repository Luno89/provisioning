import type { EnvironmentDriver, EnvironmentScope, EnvironmentSpec } from '@koala/engine-core';
import type { RunTicket } from '../temporal/contracts.js';
import type { RunWorkspace } from './workspace.js';

export interface ProvisionForRun {
  id: string;
  ticket: RunTicket;
  spec: EnvironmentSpec;
  workspace?: RunWorkspace | undefined;
  scope?: EnvironmentScope | undefined;
}

export interface RunEnvironmentOptions {
  provision: (request: ProvisionForRun) => Promise<EnvironmentDriver>;
  maxAgeMs?: number | undefined;
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

export const DEFAULT_MAX_AGE_MS = 6 * 60 * 60_000;

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
}

export function createRunEnvironments(options: RunEnvironmentOptions): RunEnvironments {
  const now = options.now ?? (() => Date.now());
  const maxAge = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const live = new Map<string, Live>();
  const starting = new Map<string, Promise<EnvironmentDriver>>();

  const dispose = async (id: string, entry: Live): Promise<void> => {
    live.delete(id);
    if (entry.owned) await entry.driver.dispose?.().catch(() => undefined);
  };

  return {
    async forRun({ ticket, id, spec, workspace, scope }): Promise<EnvironmentDriver> {
      const own = environmentIdFor(ticket.runId);
      const key = id ?? own;

      const existing = live.get(key);
      if (existing) return existing.driver;

      const inFlight = starting.get(key);
      if (inFlight) return inFlight;

      const attempt = options.provision({
        id: key,
        ticket,
        spec,
        ...(workspace ? { workspace } : {}),
        ...(scope ? { scope } : {}),
      }).then((driver) => {
        live.set(key, { driver, startedAt: now(), owned: key === own, runId: ticket.runId });
        starting.delete(key);
        return driver;
      }).catch((err: unknown) => {
        starting.delete(key);
        throw err;
      });

      starting.set(key, attempt);
      return attempt;
    },

    async release(runId: string): Promise<boolean> {
      const key = environmentIdFor(runId);
      const entry = live.get(key);
      if (!entry) return false;
      await dispose(key, entry);
      return true;
    },

    async sweep(at: number = now()): Promise<string[]> {
      const stale = [...live.entries()].filter(([, entry]) => at - entry.startedAt >= maxAge);

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

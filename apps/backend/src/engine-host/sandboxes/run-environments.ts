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
  pending?: Promise<EnvironmentDriver> | undefined;
}

export function createRunEnvironments(options: RunEnvironmentOptions): RunEnvironments {
  const now = options.now ?? (() => Date.now());
  const maxAge = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const live = new Map<string, Live>();
  const starting = new Map<string, Promise<EnvironmentDriver>>();

  const dispose = async (runId: string, entry: Live): Promise<void> => {
    live.delete(runId);
    await entry.driver.dispose?.().catch(() => undefined);
  };

  return {
    async forRun({ ticket, spec, workspace, scope }): Promise<EnvironmentDriver> {
      const existing = live.get(ticket.runId);
      if (existing) return existing.driver;

      const inFlight = starting.get(ticket.runId);
      if (inFlight) return inFlight;

      const attempt = options.provision({
        id: environmentIdFor(ticket.runId),
        ticket,
        spec,
        ...(workspace ? { workspace } : {}),
        ...(scope ? { scope } : {}),
      }).then((driver) => {
        live.set(ticket.runId, { driver, startedAt: now() });
        starting.delete(ticket.runId);
        return driver;
      }).catch((err: unknown) => {
        starting.delete(ticket.runId);
        throw err;
      });

      starting.set(ticket.runId, attempt);
      return attempt;
    },

    async release(runId: string): Promise<boolean> {
      const entry = live.get(runId);
      if (!entry) return false;
      await dispose(runId, entry);
      return true;
    },

    async sweep(at: number = now()): Promise<string[]> {
      const stale = [...live.entries()].filter(([, entry]) => at - entry.startedAt >= maxAge);

      for (const [runId, entry] of stale) {
        options.onLeak?.(runId, at - entry.startedAt);
        await dispose(runId, entry);
      }

      return stale.map(([runId]) => runId);
    },

    live(): number {
      return live.size;
    },
  };
}

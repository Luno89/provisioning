import { provisionEnding, type ProvisionReport, type ProvisionRunState } from '@koala/engine-core/koala-install';
import type { InstanceStatus } from './instances.js';

export interface InstanceSetup {
  revision: number;
  state: ProvisionRunState;
  stage: string;
  title: string;
  line?: string | undefined;
  why?: string | undefined;
  at: string;
}

export interface StatusSaid {
  status: InstanceStatus;
  detail: string;
}

const DETAIL_LIMIT = 500;

const koalaOn = (machine: string | undefined): string => (machine ? `Koala on ${machine}` : 'Koala');

export function setupHeard(setup: InstanceSetup | undefined, report: ProvisionReport, at: string): InstanceSetup | undefined {
  if (setup && report.revision < setup.revision) return undefined;
  const { progress } = report;
  const piece = { revision: report.revision, stage: progress.stage, title: progress.title, at };
  const ending = provisionEnding(progress);
  if (ending === 'failed') return { ...piece, state: 'failed', why: progress.why ?? 'it said no more' };
  if (ending === 'up') return { ...piece, state: 'up' };
  return { ...piece, state: 'running', ...(progress.state === 'started' && progress.line ? { line: progress.line } : {}) };
}

export function setupSaid(setup: InstanceSetup, machine: string | undefined): StatusSaid {
  if (setup.state === 'up') return { status: 'ready', detail: 'Ready' };
  if (setup.state === 'failed') return { status: 'failed', detail: `${koalaOn(machine)} stopped setting itself up at ${setup.title}: ${setup.why ?? 'it said no more'}`.slice(0, DETAIL_LIMIT) };
  return { status: 'installing', detail: `${koalaOn(machine)} is setting itself up: ${setup.title}${setup.line ? `, ${setup.line}` : ''}`.slice(0, DETAIL_LIMIT) };
}

export function statusSettled(said: StatusSaid, revision: number | undefined, setup: InstanceSetup | undefined, machine: string | undefined): StatusSaid {
  if (revision !== undefined) {
    if (!setup || setup.revision < revision) return said;
    return setup.state === 'up' ? { status: 'ready', detail: said.detail } : setupSaid(setup, machine);
  }
  if (said.status !== 'ready' || !setup || setup.state === 'up') return said;
  return setupSaid(setup, machine);
}

export const pastRevision = (followed: InstanceSetup, report: ProvisionReport): string =>
  `root follows the setup of revision ${followed.revision}, so revision ${report.revision}'s is no longer this Koala's`;

export const SETUP_AGAIN_PATH = '/api/instances/setup-again';

export const setUpAgainPath = (instanceId: string): string => `/api/instances/${encodeURIComponent(instanceId)}/setup-again`;

export interface SetupAsked {
  revision: number;
  at: string;
}

export type SetupAgain = 'stopped' | 'asked';

export interface SetupAgainHeld {
  status?: InstanceStatus | undefined;
  machine?: string | undefined;
  install?: { revision?: number | undefined } | undefined;
  setup?: InstanceSetup | undefined;
  setupAsked?: SetupAsked | undefined;
}

export function setupAgainOf(instance: SetupAgainHeld): SetupAgain | undefined {
  if (instance.setupAsked) return 'asked';
  const { setup } = instance;
  if (instance.status !== 'failed' || setup?.state !== 'failed') return undefined;
  return setup.revision >= (instance.install?.revision ?? 0) ? 'stopped' : undefined;
}

export type SetupAgainAsk =
  | { ok: true; patch: { setupAsked: SetupAsked; status: InstanceStatus; detail: string } }
  | { ok: false; error: string };

export function setupAgainAsked(instance: SetupAgainHeld, connected: boolean, at: string): SetupAgainAsk {
  const koala = koalaOn(instance.machine);
  const { setup } = instance;
  if (setupAgainOf(instance) !== 'stopped' || !setup) return { ok: false, error: `${koala} has not stopped setting itself up, so there is nothing to set up again` };
  const detail = connected ? `Asking ${koala} to set itself up again from ${setup.title}` : `${koala} sets itself up again from ${setup.title} once it connects to root`;
  return { ok: true, patch: { setupAsked: { revision: setup.revision, at }, status: 'installing', detail: detail.slice(0, DETAIL_LIMIT) } };
}

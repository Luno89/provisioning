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

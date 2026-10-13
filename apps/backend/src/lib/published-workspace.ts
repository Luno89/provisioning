import { createHash } from 'node:crypto';
import type { Install, PlanLine } from '@koala/agent-engine';
import type { WorkspaceFile } from './workspace-file.js';

export interface PublishedWorkspace {
  ownerId: string;
  treeId: string;
  commit?: string | undefined;
  file: WorkspaceFile;
  fingerprint: string;
  image: string;
  provides: string[];
  lines: PlanLine[];
  env: { name: string; value: string }[];
  baseEnv: { name: string; value: string }[];
  publishedAt: string;
  runId?: string | undefined;
  next?: NextWorkspace | undefined;
}

export type NextStage = 'building' | 'waiting' | 'failed' | 'declined';

export interface NextWorkspace {
  runId: string;
  commit?: string | undefined;
  stage: NextStage;
  reason?: string | undefined;
  at: string;
}

const SCRIPT_SHOWN = 60;

export function installText(install: Install): string {
  if (install.via === 'script') {
    const first = install.run.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
    return `script: ${first.length > SCRIPT_SHOWN ? `${first.slice(0, SCRIPT_SHOWN)}…` : first}`;
  }
  return install.via === 'base' ? 'nothing' : `${install.via} ${install.packages.join(', ')}`;
}

export function describeLine(line: PlanLine): string {
  return `${installText(line.install)} (${line.from})`;
}

export function stageText(next: NextWorkspace | undefined): string {
  if (!next) return 'to be rebuilt once the commit that asked for it reaches main';
  if (next.stage === 'building') return 'being rebuilt';
  if (next.stage === 'waiting') return 'waiting for the person to approve its install script, on a card in the project\'s channel';
  if (next.stage === 'declined') return 'not being rebuilt: the person declined its install script';
  return `not rebuilt: the build failed${next.reason ? ` — ${next.reason}` : ''}`;
}

export type Parking =
  | { state: 'coming' }
  | { state: 'here' }
  | { state: 'stuck'; why: string };

export function parkingFor(published: PublishedWorkspace | undefined, pending: readonly string[]): Parking {
  if (pending.length === 0) return { state: 'here' };
  const next = published?.next;
  if (next && (next.stage === 'failed' || next.stage === 'declined')) return { state: 'stuck', why: stageText(next) };
  return { state: 'coming' };
}

export const WORKSPACE_STAMP = 'koala.dev/workspace';

export function workspaceStamp(workspace: { image: string; env: readonly { name: string; value: string }[] }): string {
  const env = [...workspace.env].map((entry) => `${entry.name}=${entry.value}`).sort().join('\n');
  return createHash('sha256').update(`${workspace.image}\n${env}`).digest('hex').slice(0, 16);
}

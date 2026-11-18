import type { ProgressContract, ProgressState } from './machine-progress.js';

export const JOIN_PROGRESS_PATH = '/api/machines/join-progress';

export const JOIN_PROGRESS: ProgressContract = { lines: false };

export const MACHINE_JOINS_CHANGED = 'machine-joins-changed';

export interface MachineJoinView {
  id: string;
  stage: string;
  title: string;
  state: ProgressState;
  why?: string;
  at: string;
  expiresAt: string;
  joined: boolean;
}

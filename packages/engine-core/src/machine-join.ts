import type { ProgressContract, ProgressState } from './machine-progress.js';

export const JOIN_PROGRESS_PATH = '/api/machines/join-progress';

export const JOIN_PROGRESS: ProgressContract = { lines: false };

export const MACHINE_JOINS_CHANGED = 'machine-joins-changed';

export const WORK_TOKEN_ENDED = 'machine:work-token-ended';

export const MACHINE_CLIENT_TOKEN = 'machine:client-token';

export const MACHINE_KEY_REPLACE = 'machine:key-replace';

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

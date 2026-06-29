/**
 * WorkerService — Orchestrates the Worker life cycle inside the k3d cluster.
 */
import { exec } from 'child_process';

export interface WorkerState {
  readonly clusterId: string;
  readonly context: string;
  readonly state: 'running' | 'stopped';
}

// ─── Self-reference ───

export default class WorkerService {
  private _state: WorkerState | null = null;

  async start(
    clusterId: string,
    context: string = 'local',
  ): Promise<WorkerState> {
    if (!clusterId) throw new Error('clusterId required');
    console.log(`[WorkerService] Starting worker ${clusterId}`);
    this._state = { clusterId, context, state: 'running' };
    return this._state as WorkerState;
  }

  async close(): Promise<void> {
    if (!this._state) throw new Error('No Worker running');
    console.log(`[WorkerService] Stopping worker ${this._state.clusterId}`);
    this._state = { ...this._state, state: 'stopped' };
  }

  status(): WorkerState | null {
    return this._state;
  }
}

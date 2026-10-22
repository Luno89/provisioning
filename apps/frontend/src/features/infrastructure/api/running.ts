import { api } from '../../../api/client'

/**
 * ── DUPLICATED, KNOWINGLY ──
 * Authority: `RunningItem`, `OpensAt` and `CancelHow` in apps/backend/src/infrastructure/lib/running.ts,
 * `RunningView` in apps/backend/src/infrastructure/services/RunningService.ts.
 */
export type RunningKind = 'bench' | 'check' | 'memory-keeper' | 'tree' | 'release' | 'chat' | 'run' | 'workspace-build' | 'plan' | 'removal' | 'save' | 'deploy' | 'other'

export interface RunningItem {
  workflowId: string
  kind: RunningKind
  title: string
  since: string
  opens: { kind: 'chat' | 'tree' | 'project' | 'checks' | 'temporal'; id?: string }
  cancel: { via: 'check' | 'tree' | 'run' | 'workflow' } | { via: 'none'; why: string }
  asking?: string[]
  waitsFor?: string[]
}

export interface RunningView {
  items: RunningItem[]
  bench: { paused: boolean }
  keeper: { paused: boolean; held: number }
}

export const runningKeys = {
  view: () => ['running'] as const,
}

export const getRunning = (): Promise<RunningView> => api.get<RunningView>('/running').then((r) => r.data)

export const cancelRunning = (workflowId: string): Promise<void> =>
  api.post(`/running/${encodeURIComponent(workflowId)}/cancel`, {}).then(() => undefined)

export const pauseBench = (paused: boolean): Promise<{ paused: boolean }> =>
  api.put<{ paused: boolean }>('/running/bench', { paused }).then((r) => r.data)

export const pauseKeeper = (paused: boolean): Promise<{ paused: boolean; held: number }> =>
  api.put<{ paused: boolean; held: number }>('/running/keeper', { paused }).then((r) => r.data)

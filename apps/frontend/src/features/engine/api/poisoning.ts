import { api } from '../../../api/client'
import type { SignalView } from '../types/poisoning'

export const poisoningKeys = {
  all: ['poisoning'] as const,
  run: (runId: string) => ['poisoning', 'run', runId] as const,
}

export const listRunSignals = (runId: string): Promise<SignalView[]> =>
  api.get<{ signals: SignalView[] }>('/poisoning', { params: { runId } }).then((r) => r.data.signals)

export const dismissSignal = (id: string, because?: string): Promise<SignalView> =>
  api.post<SignalView>(`/poisoning/${encodeURIComponent(id)}/dismiss`, because ? { because } : {}).then((r) => r.data)

export const retireFromSignal = (id: string, scope: 'run' | 'source'): Promise<{ retired: number; signal: SignalView }> =>
  api.post<{ retired: number; signal: SignalView }>(`/poisoning/${encodeURIComponent(id)}/retire`, { scope }).then((r) => r.data)

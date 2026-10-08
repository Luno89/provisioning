import { api } from './client.js'
import type { TurnLogEntry } from '../types/turns'

export const TURN_LOG_CHANNEL = 'turn-log'

export async function readTurn(turnId: string, after: number): Promise<TurnLogEntry[]> {
  return (await api.get<{ entries: TurnLogEntry[] }>(`/turns/${encodeURIComponent(turnId)}`, { params: { after } })).data.entries
}

export interface RecentTurn {
  turnId: string
  at: string
  agentId?: string | undefined
}

export const turnKeys = {
  recent: () => ['turns', 'recent'] as const,
}

export async function listRecentTurns(): Promise<RecentTurn[]> {
  return (await api.get<{ turns: RecentTurn[] }>('/turns')).data.turns
}

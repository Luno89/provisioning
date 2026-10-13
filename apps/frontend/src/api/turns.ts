import { api } from './client.js'
import type { TurnLogEntry } from '../types/turns'

export const TURN_LOG_CHANNEL = 'turn-log'

export async function readTurn(turnId: string, after: number): Promise<TurnLogEntry[]> {
  return (await api.get<{ entries: TurnLogEntry[] }>(`/turns/${encodeURIComponent(turnId)}`, { params: { after } })).data.entries
}

export async function readRunsUnder(turnId: string, after: number, under: string): Promise<{ entries: TurnLogEntry[]; through: number }> {
  return (await api.get<{ entries: TurnLogEntry[]; through: number }>(`/turns/${encodeURIComponent(turnId)}`, { params: { after, under } })).data
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

import { api } from './client.js'
import type { TurnLogEntry } from '../types/turns'

/** The socket channel a turn's log entries are announced on, once written. */
export const TURN_LOG_CHANNEL = 'turn-log'

export async function readTurn(turnId: string, after: number): Promise<TurnLogEntry[]> {
  return (await api.get<{ entries: TurnLogEntry[] }>(`/turns/${encodeURIComponent(turnId)}`, { params: { after } })).data.entries
}

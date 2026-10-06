import type { EngineEvent } from '../api/engine'

/**
 * ── DUPLICATED, KNOWINGLY ──
 * Mirrors `TurnLogEntry` in apps/backend/src/lib/turn-log.ts, which wins; the owner is not sent.
 */
export interface TurnLogEntry {
  turnId: string
  seq: number
  events: EngineEvent[]
  at: string
}

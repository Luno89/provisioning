import type { TurnLogEntry } from '../types/turns'

type Apply = (entry: TurnLogEntry) => void

interface Followed {
  lastSeq: number
  catchingUp: Promise<void> | null
  held: TurnLogEntry[]
}

export type TurnRead = TurnLogEntry[] | { entries: TurnLogEntry[]; through: number }

export function createTurnFollower(read: (turnId: string, after: number) => Promise<TurnRead>) {
  const turns = new Map<string, Followed>()

  const applyInOrder = (turn: Followed, entries: readonly TurnLogEntry[], apply: Apply): boolean => {
    for (const entry of [...entries].sort((a, b) => a.seq - b.seq)) {
      if (entry.seq <= turn.lastSeq) continue
      if (entry.seq !== turn.lastSeq + 1) return false
      apply(entry)
      turn.lastSeq = entry.seq
    }
    return true
  }

  const catchUp = (turnId: string, apply: Apply): Promise<void> => {
    const turn = turns.get(turnId)
    if (!turn) return Promise.resolve()
    if (turn.catchingUp) return turn.catchingUp
    const run = async () => {
      try {
        for (;;) {
          const got = await read(turnId, turn.lastSeq)
          if (Array.isArray(got)) {
            applyInOrder(turn, got, apply)
          } else {
            for (const entry of [...got.entries].sort((a, b) => a.seq - b.seq)) {
              if (entry.seq <= turn.lastSeq) continue
              apply(entry)
              turn.lastSeq = entry.seq
            }
            turn.lastSeq = Math.max(turn.lastSeq, got.through)
          }
          const held = turn.held.splice(0, turn.held.length)
          if (applyInOrder(turn, held, apply)) return
        }
      } finally {
        turn.catchingUp = null
      }
    }
    turn.catchingUp = run()
    return turn.catchingUp
  }

  return {
    follow(turnId: string, apply: Apply): Promise<void> {
      if (!turns.has(turnId)) turns.set(turnId, { lastSeq: 0, catchingUp: null, held: [] })
      return catchUp(turnId, apply)
    },
    following: (turnId: string): boolean => turns.has(turnId),
    forget(turnId: string): void {
      turns.delete(turnId)
    },
    receive(entry: TurnLogEntry, apply: Apply): void {
      const turn = turns.get(entry.turnId)
      if (!turn) return
      if (turn.catchingUp) {
        turn.held.push(entry)
        return
      }
      if (!applyInOrder(turn, [entry], apply)) {
        turn.held.push(entry)
        void catchUp(entry.turnId, apply)
      }
    },
    catchUp,
    followed: (): string[] => [...turns.keys()],
  }
}

export type TurnFollower = ReturnType<typeof createTurnFollower>

import { describe, it, expect } from 'vitest'
import { createTurnFollower } from './turn-follower'
import type { TurnLogEntry } from '../types/turns'

const entry = (seq: number, turnId = 't1'): TurnLogEntry => ({ turnId, seq, events: [], at: 'now' })

const logOf = (entries: TurnLogEntry[]) => {
  const reads: [string, number][] = []
  return {
    reads,
    read: async (turnId: string, after: number) => {
      reads.push([turnId, after])
      return entries.filter((one) => one.turnId === turnId && one.seq > after)
    },
  }
}

describe('following a turn\'s log', () => {
  it('reads what the turn already holds when it starts following, then applies each pushed entry once, in order', async () => {
    const log = logOf([entry(1), entry(2)])
    const follower = createTurnFollower(log.read)
    const applied: number[] = []
    const apply = (one: TurnLogEntry) => { applied.push(one.seq) }

    await follower.follow('t1', apply)
    follower.receive(entry(2), apply)
    follower.receive(entry(3), apply)
    follower.receive(entry(3), apply)

    expect(applied).toEqual([1, 2, 3])
  })

  it('fills in from the log when a pushed entry skips ahead, then carries on with what arrived meanwhile', async () => {
    const log = logOf([entry(1), entry(2), entry(3), entry(4), entry(5)])
    const follower = createTurnFollower(log.read)
    const applied: number[] = []
    const apply = (one: TurnLogEntry) => { applied.push(one.seq) }
    await follower.follow('t1', apply)
    log.reads.length = 0

    follower.receive(entry(1), apply)
    log.read = async (turnId, after) => { log.reads.push([turnId, after]); return [entry(2), entry(3)].filter((one) => one.seq > after) }
    follower.receive(entry(4), apply)
    follower.receive(entry(5), apply)
    await follower.catchUp('t1', apply)

    expect(applied).toEqual([1, 2, 3, 4, 5])
  })

  it('catches up on what it missed while nobody listened', async () => {
    const entries = [entry(1)]
    const log = logOf(entries)
    const follower = createTurnFollower((turnId, after) => log.read(turnId, after))
    const applied: number[] = []
    const apply = (one: TurnLogEntry) => { applied.push(one.seq) }
    await follower.follow('t1', apply)

    entries.push(entry(2), entry(3))
    await follower.catchUp('t1', apply)

    expect(applied).toEqual([1, 2, 3])
    expect(log.reads.at(-1)).toEqual(['t1', 1])
  })

  it('ignores turns it does not follow, and stops when told to', async () => {
    const follower = createTurnFollower(logOf([]).read)
    const applied: number[] = []
    const apply = (one: TurnLogEntry) => { applied.push(one.seq) }

    follower.receive(entry(1, 'other'), apply)
    await follower.follow('t1', apply)
    follower.forget('t1')
    follower.receive(entry(1), apply)

    expect(applied).toEqual([])
    expect(follower.following('t1')).toBe(false)
  })
})

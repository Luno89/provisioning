import { describe, expect, expectTypeOf, it } from 'vitest'
import { listRecentTurns, readRunsUnder, readTurn } from './turns'
import type { TurnLogEntry } from '../types/turns'
import { startBackend } from '../../../test/backend/site'
import { mountEngine } from '../../../test/backend/engine'
import type { Wire } from '../../../test/backend/wire'
import type { TurnLogEntry as BackendEntry } from '../../../../../backend/src/engine/lib/turn-log'

const backend = await startBackend((site) => { mountEngine(site) })
const owner = await backend.signIn()
const at = new Date().toISOString()

await backend.db.engine.appendTurnLog({ turnId: 'turn-1', ownerId: owner.id, seq: 1, at, events: [{ type: 'run.started', runId: 'turn-1', at, agentId: 'koala', loopId: 'interactive-chat' }] })
await backend.db.engine.appendTurnLog({ turnId: 'turn-1', ownerId: owner.id, seq: 2, at, events: [{ type: 'run.started', runId: 'child-1', at, agentId: 'research', loopId: 'research', parentRunId: 'turn-1', parentCallId: 'call-1' }] })
await backend.db.engine.appendTurnLog({ turnId: 'turn-1', ownerId: owner.id, seq: 3, at, events: [{ type: 'content', runId: 'child-1', at, nodeId: 'model', delta: 'found it' }] })
await backend.db.engine.appendTurnLog({ turnId: 'turn-1', ownerId: owner.id, seq: 4, at, events: [{ type: 'content', runId: 'turn-1', at, nodeId: 'model', delta: 'hello' }] })

describe('the shapes the browser reads are the shapes the backend sends', () => {
  it('reads a turn log entry as the backend describes one, without its owner', () => {
    expectTypeOf<Wire<Omit<BackendEntry, 'ownerId'>>>().toExtend<TurnLogEntry>()
  })
})

describe('a turn\'s live log, as the chat and Watch it work read it', () => {
  it('reads the log after a position, never sending whose it is', async () => {
    const entries = await readTurn('turn-1', 2)
    expect(entries.map((entry) => entry.seq)).toEqual([3, 4])
    expect(entries[0]).toEqual({ turnId: 'turn-1', seq: 3, at, events: [{ type: 'content', runId: 'child-1', at, nodeId: 'model', delta: 'found it' }] })
  })

  it('reads only one run\'s family with how far it read', async () => {
    const under = await readRunsUnder('turn-1', 0, 'child-1')
    expect(under.through).toBe(4)
    expect(under.entries.flatMap((entry) => entry.events.map((event) => event.runId))).toEqual(['child-1', 'child-1'])
  })

  it('refuses a position that is not a whole number', async () => {
    await expect(readTurn('turn-1', -1)).rejects.toMatchObject({ response: { status: 400, data: { error: 'after is a position in the log: a whole number, 0 or more' } } })
  })

  it('lists the recent turns with the agent that ran each', async () => {
    expect(await listRecentTurns()).toEqual([{ turnId: 'turn-1', at, agentId: 'koala' }])
  })

  it('shows another person nothing of the first person\'s turns', async () => {
    await backend.signInAnother('second@koala.test')
    expect(await readTurn('turn-1', 0)).toEqual([])
    expect(await listRecentTurns()).toEqual([])
  })
})

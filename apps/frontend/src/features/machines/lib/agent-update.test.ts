import { describe, it, expect } from 'vitest'
import { agentUpdateLine } from './agent-update'

const B = 'b'.repeat(64)

describe('what My Machines says about a machine\'s agent', () => {
  it('says nothing when Koala has nothing to say', () => {
    expect(agentUpdateLine(undefined, true)).toBeUndefined()
  })

  it('says when it is up to date', () => {
    expect(agentUpdateLine({ state: 'current', current: B, running: B }, true)).toEqual({ tone: 'ok', text: 'Its agent is up to date.' })
  })

  it('says a newer agent waits for the machine to be idle, and what it is busy with', () => {
    expect(agentUpdateLine({ state: 'waiting', current: B, busyWith: ['a session of gemini', 'a tool call'] }, true)?.text)
      .toBe('A newer agent is ready; it updates itself as soon as nothing runs on it (now: a session of gemini and a tool call).')
    expect(agentUpdateLine({ state: 'waiting', current: B }, true)?.text).toBe('A newer agent is ready; it updates itself as soon as nothing runs on it.')
  })

  it('says when it is updating, and when a newer one waits for it to connect', () => {
    expect(agentUpdateLine({ state: 'updating', current: B }, true)).toEqual({ tone: 'busy', text: 'Its agent is updating itself.' })
    expect(agentUpdateLine({ state: 'behind', current: B }, false)?.text).toMatch(/next time it connects/)
    expect(agentUpdateLine({ state: 'behind', current: B }, true)?.text).toMatch(/about to take/)
  })

  it('says why an update failed, and that the agent it has keeps running', () => {
    expect(agentUpdateLine({ state: 'failed', current: B, reason: 'npm ci failed: npm error network' }, true))
      .toEqual({ tone: 'bad', text: 'Its agent could not update itself: npm ci failed: npm error network. It keeps running the agent it has, and tries again the next time it connects.' })
  })

  it('tells the person to run the command again when the agent is too old, or not running as its service', () => {
    expect(agentUpdateLine({ state: 'too-old', current: B }, true)).toEqual({ tone: 'warn', text: 'Its agent is too old to update itself. Run the command from My Machines on it again to install the current one, which keeps itself up to date.' })
    expect(agentUpdateLine({ state: 'not-a-service', current: B }, true)?.text).toMatch(/not started as its service.*Run the command from My Machines on it again/)
  })
})

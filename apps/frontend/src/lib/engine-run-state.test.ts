import { describe, it, expect } from 'vitest'
import { emptyRunState, pendingApproval, reduceEngineEvent, reduceEngineEvents } from './engine-run-state'
import type { EngineEvent } from '../api/engine'

const at = '2026-01-01T00:00:00.000Z'
const base = { runId: 'run-1', at }

describe('engine run state', () => {
  it('records which agent and loop a run is', () => {
    const state = reduceEngineEvent(emptyRunState('run-1'), {
      ...base, type: 'run.started', agentId: 'koala', loopId: 'interactive-chat',
    } as EngineEvent)

    expect(state).toMatchObject({ agentId: 'koala', loopId: 'interactive-chat', finished: false })
  })

  it('accumulates thinking and content separately as they stream', () => {
    const events: EngineEvent[] = [
      { ...base, type: 'thinking', nodeId: 'think', delta: 'weighing ' },
      { ...base, type: 'thinking', nodeId: 'think', delta: 'it up' },
      { ...base, type: 'content', nodeId: 'think', delta: 'the ' },
      { ...base, type: 'content', nodeId: 'think', delta: 'answer' },
    ] as EngineEvent[]

    const state = reduceEngineEvents('run-1', events)

    expect(state.thinking).toBe('weighing it up')
    expect(state.content).toBe('the answer')
  })

  it('tracks which node is active and where the run has been', () => {
    const state = reduceEngineEvents('run-1', [
      { ...base, type: 'node.entered', nodeId: 'think' },
      { ...base, type: 'node.entered', nodeId: 'work' },
      { ...base, type: 'node.entered', nodeId: 'think' },
    ] as EngineEvent[])

    expect(state.currentNode).toBe('think')
    expect(state.visited).toEqual(['think', 'work'])
  })

  it('shows a tool call running, then its result', () => {
    const running = reduceEngineEvents('run-1', [
      { ...base, type: 'tool.called', nodeId: 'work', callId: 'c1', name: 'read_file', args: '{}' },
    ] as EngineEvent[])

    expect(running.toolCalls[0]).toMatchObject({ name: 'read_file', running: true })

    const settled = reduceEngineEvent(running, {
      ...base, type: 'tool.result', nodeId: 'work', callId: 'c1', ok: true, digest: 'contents',
    } as EngineEvent)

    expect(settled.toolCalls[0]).toMatchObject({ running: false, ok: true, digest: 'contents' })
  })

  it('does not duplicate a tool call it has already seen', () => {
    const state = reduceEngineEvents('run-1', [
      { ...base, type: 'tool.called', nodeId: 'work', callId: 'c1', name: 'read_file', args: '{}' },
      { ...base, type: 'tool.called', nodeId: 'work', callId: 'c1', name: 'read_file', args: '{}' },
    ] as EngineEvent[])

    expect(state.toolCalls).toHaveLength(1)
  })

  it('ignores events belonging to another run', () => {
    const state = reduceEngineEvents('run-1', [
      { ...base, type: 'content', nodeId: 'think', delta: 'mine' },
      { runId: 'run-2', at, type: 'content', nodeId: 'think', delta: 'not mine' },
    ] as EngineEvent[])

    expect(state.content).toBe('mine')
  })

  it('surfaces the outcome when the run finishes, and clears the active node', () => {
    const state = reduceEngineEvents('run-1', [
      { ...base, type: 'node.entered', nodeId: 'think' },
      { ...base, type: 'run.finished', outcome: 'exhausted', reason: 'used all 3 rounds' },
    ] as EngineEvent[])

    expect(state).toMatchObject({ finished: true, outcome: 'exhausted', outcomeReason: 'used all 3 rounds' })
    expect(state.currentNode).toBeUndefined()
  })

  it('keeps the interruption reason when a monitor stops a run', () => {
    const state = reduceEngineEvents('run-1', [
      { ...base, type: 'interrupted', reason: 'going in circles (repetition)' },
    ] as EngineEvent[])

    expect(state.interruptedReason).toContain('going in circles')
  })

  it('collects notices, and surfaces the latest warning as a pending approval', () => {
    const state = reduceEngineEvents('run-1', [
      { ...base, type: 'notice', level: 'info', message: 'Which database?' },
      { ...base, type: 'notice', level: 'warn', message: 'executor wants to run run_command on Tallgeese: {}' },
    ] as EngineEvent[])

    expect(state.notices).toHaveLength(2)
    expect(pendingApproval(state)).toContain('Tallgeese')
  })

  it('has no pending approval when nothing is waiting', () => {
    expect(pendingApproval(emptyRunState('run-1'))).toBeUndefined()
  })
})

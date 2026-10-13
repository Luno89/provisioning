import { describe, it, expect } from 'vitest'
import { emptyRunState, pendingApproval, reduceEngineEvent, reduceEngineEvents, applyInstanceEvents, instancesUnder } from './engine-run-state'
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

  it('takes the step the model is speaking in as the one it is on, before that step is logged as entered', () => {
    const state = reduceEngineEvents('run-1', [
      { ...base, type: 'node.entered', nodeId: 'turn.compact' },
      { ...base, type: 'thinking', nodeId: 'turn.call', delta: 'hmm' },
    ] as EngineEvent[])

    expect(state.currentNode).toBe('turn.call')
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

describe('the runs of one story inside its tree\'s turn', () => {
  const started = (runId: string, at: string, parentRunId?: string): EngineEvent => ({ type: 'run.started', runId, at, agentId: 'a', loopId: 'l', ...(parentRunId ? { parentRunId } : {}) })
  const thought = (runId: string, at: string, delta: string): EngineEvent => ({ type: 'thinking', runId, at, nodeId: 'model', delta })

  it('keeps a story\'s worker run and the runs it started, apart from another story\'s worker in the same turn', () => {
    const runs = applyInstanceEvents([], [started('grove', '1'), started('leaf-a', '2', 'grove'), started('task-1', '3', 'leaf-a'), started('leaf-b', '4', 'grove'), thought('task-1', '5', 'reading the view')])
    expect(instancesUnder(runs, 'leaf-a').map((run) => [run.runId, run.thinking])).toEqual([['leaf-a', ''], ['task-1', 'reading the view']])
  })

  it('tells apart two runs that reused the same ids, by when they started and when the story was settled', () => {
    const runs = applyInstanceEvents([], [
      started('leaf-1', '2026-10-09T01:00:00Z', 'grove'), started('leaf-1-executor-1', '2026-10-09T01:01:00Z', 'leaf-1'), thought('leaf-1-executor-1', '2026-10-09T01:02:00Z', 'the first story'),
      started('leaf-1', '2026-10-10T01:00:00Z', 'grove'), started('leaf-1-executor-1', '2026-10-10T01:01:00Z', 'leaf-1'), thought('leaf-1-executor-1', '2026-10-10T01:02:00Z', 'the second story'),
    ])
    expect(instancesUnder(runs, 'leaf-1').map((run) => run.thinking)).toEqual(['', 'the second story'])
    expect(instancesUnder(runs, 'leaf-1', '2026-10-09T05:00:00Z').map((run) => run.thinking)).toEqual(['', 'the first story'])
  })
})

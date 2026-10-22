import { describe, it, expect } from 'vitest'
import type { NodeTrace } from '@koala/agent-engine/procedure'
import type { EngineEvent } from '../api/engine'
import { groupPathOf, nodeAtDepth, statesFromEvents, statesFromKey, statesKey, statesFromTraces, tracesFromEvents, withStoredTraces } from './procedure-run'

const at = '2026-09-16T00:00:00.000Z'
const runId = 'run-1'
const trace = (sequence: number, node: string, extra: Partial<NodeTrace> = {}): NodeTrace => ({
  sequence, step: sequence, node, origin: node, kind: 'k', role: 'step', cleanup: false, startedAt: 0, durationMs: 1, inputs: {}, ...extra,
})

describe('which node a running node lights up', () => {
  it('lights up the group node from outside the group, and the node itself from inside it', () => {
    expect(nodeAtDepth('turn.call', [])).toBe('turn')
    expect(nodeAtDepth('turn.call', ['model-turn'])).toBe('call')
    expect(nodeAtDepth('finish', ['model-turn'])).toBeUndefined()
  })

  it('finds the groups to open to reach a node', () => {
    const groups: Record<string, string> = { turn: 'model-turn', 'turn.loop': 'tool-loop' }
    expect(groupPathOf('turn.loop.run', (instance) => groups[instance.join('.')])).toEqual(['model-turn', 'tool-loop'])
    expect(groupPathOf('finish', () => undefined)).toEqual([])
  })
})

describe('node states during a live run', () => {
  it('marks the node running now, the ones that ran as done, and one that errored as failed', () => {
    const events: EngineEvent[] = [
      { type: 'node.entered', runId, at, nodeId: 'provision' },
      { type: 'node.traced', runId, at, nodeId: 'provision', trace: {} },
      { type: 'node.exited', runId, at, nodeId: 'provision', via: 'ready' },
      { type: 'node.traced', runId, at, nodeId: 'memory', trace: { error: 'no memory store' } },
      { type: 'node.entered', runId, at, nodeId: 'turn.call' },
    ]

    expect(statesFromEvents(events, [])).toEqual({ provision: 'done', memory: 'failed', turn: 'running' })
    expect(statesFromEvents([...events, { type: 'run.finished', runId, at, outcome: 'ok' }], [])).toEqual({ provision: 'done', memory: 'failed' })
  })

  it('shows the model call running while it streams, though only the step before it is logged as entered', () => {
    const events: EngineEvent[] = [
      { type: 'node.entered', runId, at, nodeId: 'turn.compact' },
      { type: 'thinking', runId, at, nodeId: 'turn.call', delta: 'hmm' },
    ]

    expect(statesFromEvents(events, ['model-turn'])).toEqual({ call: 'running' })
  })
})

describe('whether the graph needs drawing again', () => {
  it('keys the states by what they say, whatever order they came in', () => {
    expect(statesKey({ call: 'running', compact: 'done' })).toBe(statesKey({ compact: 'done', call: 'running' }))
    expect(statesKey({ call: 'running' })).not.toBe(statesKey({ call: 'done' }))
    expect(statesKey({ call: 'running' })).not.toBe(statesKey({ call: 'running', fit: 'done' }))
    expect(statesFromKey(statesKey({ call: 'running', compact: 'done' }))).toEqual({ call: 'running', compact: 'done' })
  })
})

describe('replaying a stored run', () => {
  it('shows everything that ran up to the chosen step, with that step in focus', () => {
    const traces = [trace(1, 'provision'), trace(2, 'turn.context', { role: 'value' }), trace(3, 'turn.call', { error: 'refused' }), trace(4, 'verdict')]

    expect(statesFromTraces(traces, [], 2)).toEqual({ provision: 'done', turn: 'running' })
    expect(statesFromTraces(traces, [])).toEqual({ provision: 'done', turn: 'failed', verdict: 'done' })
    expect(statesFromTraces(traces, ['model-turn'], 3)).toEqual({ context: 'done', call: 'failed' })
  })

  it('collects traces from live events in the order they ran', () => {
    const events: EngineEvent[] = [
      { type: 'node.traced', runId, at, nodeId: 'b', trace: trace(2, 'b') as unknown as Record<string, unknown> },
      { type: 'content', runId, at, nodeId: 'b', delta: 'x' },
      { type: 'node.traced', runId, at, nodeId: 'a', trace: trace(1, 'a') as unknown as Record<string, unknown> },
    ]
    expect(tracesFromEvents(events).map((entry) => entry.node)).toEqual(['a', 'b'])
  })
})

describe('the traces a live run shows', () => {
  it('uses the stored trace of each step it has, with its inputs, and the logged summary of the rest', () => {
    const logged = [trace(1, 'provision'), trace(2, 'turn.call')]
    const stored = [{ ...trace(1, 'provision'), inputs: { size: 'small' } }, { ...trace(3, 'verdict'), inputs: {} }]

    expect(withStoredTraces(logged, stored)).toEqual([stored[0], logged[1], stored[1]])
    expect(withStoredTraces(logged, [])).toEqual(logged)
  })
})

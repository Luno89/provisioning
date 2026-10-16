import { describe, expect, it } from 'vitest'
import type { EngineEvent } from '../api/engine'
import { keptForStory, roundsFrom, shownArgs, withInstanceEvents } from './run-rounds'

const at = 't'
const events: EngineEvent[] = [
  { type: 'run.started', runId: 'r', at: 't0', agentId: 'executor', loopId: 'do-one-task' },
  { type: 'model.requested', runId: 'r', at: 't1', nodeId: 'turn.call', model: 'tabby', toolNames: ['run_command'] },
  { type: 'thinking', runId: 'r', at, nodeId: 'turn.call', delta: 'look at ' },
  { type: 'thinking', runId: 'r', at, nodeId: 'turn.call', delta: 'the form' },
  { type: 'content', runId: 'r', at, nodeId: 'turn.call', delta: 'Checking.' },
  { type: 'tool.called', runId: 'r', at, nodeId: 'tools.run', callId: 'c1', name: 'run_command', args: '{"command":"odoo-e2e --keep m e2e","timeoutSeconds":300}' },
  { type: 'model.requested', runId: 'r', at: 't2', nodeId: 'turn.call', toolNames: [] },
  { type: 'tool.result', runId: 'r', at, nodeId: 'tools.run', callId: 'c1', ok: true, digest: '1 passed' },
  { type: 'content', runId: 'r', at, nodeId: 'turn.call', delta: 'Done.' },
]

describe('the rounds of a run', () => {
  it('gives each model request its thinking, its words and the calls it made, with their results', () => {
    expect(roundsFrom(events)).toEqual([
      { index: 1, by: 'model', nodeId: 'turn.call', startedAt: 't1', model: 'tabby', thinking: 'look at the form', content: 'Checking.', calls: [{ callId: 'c1', name: 'run_command', args: '{"command":"odoo-e2e --keep m e2e","timeoutSeconds":300}', running: false, ok: true, digest: '1 passed' }] },
      { index: 2, by: 'model', nodeId: 'turn.call', startedAt: 't2', thinking: '', content: 'Done.', calls: [] },
    ])
  })

  it('starts a round each time the model\'s step is entered again, when the log holds no requests', () => {
    const logged: EngineEvent[] = [
      { type: 'node.entered', runId: 'r', at: 'a1', nodeId: 'turn.call' },
      { type: 'thinking', runId: 'r', at: 'a2', nodeId: 'turn.call', delta: 'first' },
      { type: 'tool.called', runId: 'r', at: 'a3', nodeId: 'tools.run', callId: 'c1', name: 'read_file', args: '{"path":"a"}' },
      { type: 'node.entered', runId: 'r', at: 'a4', nodeId: 'tools.run' },
      { type: 'tool.result', runId: 'r', at: 'a5', nodeId: 'tools.run', callId: 'c1', ok: true, digest: 'x' },
      { type: 'node.entered', runId: 'r', at: 'a6', nodeId: 'turn.call' },
      { type: 'thinking', runId: 'r', at: 'a7', nodeId: 'turn.call', delta: 'second, ' },
      { type: 'thinking', runId: 'r', at: 'a8', nodeId: 'turn.call', delta: 'still second' },
      { type: 'content', runId: 'r', at: 'a9', nodeId: 'turn.call', delta: 'Done.' },
    ]
    expect(roundsFrom(logged).map((round) => [round.index, round.startedAt, round.thinking, round.content, round.calls.map((call) => `${call.name}:${call.ok}`)])).toEqual([
      [1, 'a2', 'first', '', ['read_file:true']],
      [2, 'a7', 'second, still second', 'Done.', []],
    ])
  })

  it('names each round after the model the run chose, even when that choice is logged after the round began', () => {
    const logged: EngineEvent[] = [
      { type: 'node.entered', runId: 'r', at: 'a1', nodeId: 'turn.call' },
      { type: 'content', runId: 'r', at: 'a2', nodeId: 'turn.call', delta: 'One.' },
      { type: 'node.traced', runId: 'r', at: 'a3', nodeId: 'turn.model', trace: { kind: 'choose-model', model: 'Qwen3.8-27B' } },
      { type: 'node.entered', runId: 'r', at: 'a4', nodeId: 'turn.call' },
      { type: 'content', runId: 'r', at: 'a5', nodeId: 'turn.call', delta: 'Two.' },
    ]
    expect(roundsFrom(logged).map((round) => round.model)).toEqual(['Qwen3.8-27B', 'Qwen3.8-27B'])
    expect(roundsFrom([
      { type: 'content', runId: 'r', at: 'b1', nodeId: 'agent', delta: 'Done.' },
      { type: 'node.traced', runId: 'r', at: 'b2', nodeId: 'agent', trace: { kind: 'external-agent', model: 'Antigravity · Gemini 3.8 Flash' } },
    ]).map((round) => round.model)).toEqual(['Antigravity · Gemini 3.8 Flash'])
  })

  it('shows a call the procedure makes itself as its own step, apart from the model\'s rounds', () => {
    const logged: EngineEvent[] = [
      { type: 'node.entered', runId: 'r', at: 'b1', nodeId: 'claim' },
      { type: 'tool.called', runId: 'r', at: 'b2', nodeId: 'claim', callId: 'k1', name: 'start_task', args: '{"taskId":"t1"}' },
      { type: 'tool.result', runId: 'r', at: 'b3', nodeId: 'claim', callId: 'k1', ok: true, digest: 'started t1' },
      { type: 'node.traced', runId: 'r', at: 'b4', nodeId: 'claim', trace: { kind: 'call-tool' } },
      { type: 'node.entered', runId: 'r', at: 'b5', nodeId: 'turn.call' },
      { type: 'content', runId: 'r', at: 'b6', nodeId: 'turn.call', delta: 'Working.' },
      { type: 'tool.called', runId: 'r', at: 'b7', nodeId: 'tools.run', callId: 'c1', name: 'run_command', args: '{"command":"ls"}' },
      { type: 'node.traced', runId: 'r', at: 'b8', nodeId: 'tools.run', trace: { kind: 'run-tool-calls' } },
      { type: 'node.entered', runId: 'r', at: 'b9', nodeId: 'record' },
      { type: 'tool.called', runId: 'r', at: 'b10', nodeId: 'record', callId: 'k2', name: 'mark_done', args: '{}' },
      { type: 'node.traced', runId: 'r', at: 'b11', nodeId: 'record', trace: { kind: 'call-tool' } },
    ]
    expect(roundsFrom(logged).map((round) => [round.by, round.index, round.nodeId, round.calls.map((call) => call.name)])).toEqual([
      ['procedure', 0, 'claim', ['start_task']],
      ['model', 1, 'turn.call', ['run_command']],
      ['procedure', 1, 'record', ['mark_done']],
    ])
  })

  it('keeps what streamed before any request was seen', () => {
    expect(roundsFrom([{ type: 'content', runId: 'r', at: 't9', nodeId: 'turn.call', delta: 'hi' }])).toEqual([
      { index: 1, by: 'model', nodeId: 'turn.call', startedAt: 't9', thinking: '', content: 'hi', calls: [] },
    ])
  })

  it('shows a command as the command, and anything else as its arguments', () => {
    expect(shownArgs('{"command":"npm test","timeoutSeconds":60}')).toBe('npm test\ntimeoutSeconds: 60')
    expect(shownArgs('{"path":"a.ts"}')).toBe('{\n  "path": "a.ts"\n}')
    expect(shownArgs('not json')).toBe('not json')
  })
})

describe('each run\'s own events', () => {
  it('keeps a run started again apart from its first start, and adds to the right one as events stream in', () => {
    const first = withInstanceEvents({}, {}, [
      { type: 'run.started', runId: 'a', at: 't0', agentId: 'x', loopId: 'p' },
      { type: 'content', runId: 'a', at, nodeId: 'n', delta: '1' },
      { type: 'content', runId: 'b', at, nodeId: 'n', delta: 'orphan' },
    ])
    const second = withInstanceEvents(first.grouped, first.latest, [
      { type: 'run.started', runId: 'a', at: 't5', agentId: 'x', loopId: 'p' },
      { type: 'content', runId: 'a', at, nodeId: 'n', delta: '2' },
    ])
    expect(Object.fromEntries(Object.entries(second.grouped).map(([key, list]) => [key, list.length]))).toEqual({ 'a@t0': 2, 'b@': 1, 'a@t5': 2 })
    expect(first.grouped['a@t0']).toHaveLength(2)
  })
})

describe('what a story keeps of its tree\'s log', () => {
  it('keeps the runs it started and theirs, and of each trace only its kind, error and model, never the conversation it carried', () => {
    const family = new Set(['leaf'])
    const kept = keptForStory([
      { type: 'run.started', runId: 'task', at, agentId: 'executor', loopId: 'l', parentRunId: 'leaf' },
      { type: 'run.started', runId: 'other', at, agentId: 'leaf-worker', loopId: 'l', parentRunId: 'tree' },
      { type: 'node.traced', runId: 'task', at, nodeId: 'turn.compact', trace: { kind: 'compact-context', inputs: { messages: ['a long conversation'] }, outputs: { messages: [] } } },
      { type: 'node.traced', runId: 'task', at, nodeId: 'turn.call', trace: { kind: 'call-model', error: 'refused', inputs: {} } },
      { type: 'node.traced', runId: 'task', at, nodeId: 'turn.model', trace: { kind: 'choose-model', model: 'Qwen3.8-27B', inputs: {} } },
      { type: 'thinking', runId: 'other', at, nodeId: 'turn.call', delta: 'not this story' },
    ], family)

    expect(kept).toEqual([
      { type: 'run.started', runId: 'task', at, agentId: 'executor', loopId: 'l', parentRunId: 'leaf' },
      { type: 'node.traced', runId: 'task', at, nodeId: 'turn.compact', trace: { kind: 'compact-context' } },
      { type: 'node.traced', runId: 'task', at, nodeId: 'turn.call', trace: { kind: 'call-model', error: 'refused' } },
      { type: 'node.traced', runId: 'task', at, nodeId: 'turn.model', trace: { kind: 'choose-model', model: 'Qwen3.8-27B' } },
    ])
    expect([...family]).toEqual(['leaf', 'task'])
  })
})

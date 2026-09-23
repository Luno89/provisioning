import { describe, it, expect } from 'vitest'
import type { EngineEvent } from '../../api/engine'
import { engineEventToFrame } from './engine-event-frames'

const base = { runId: 'r1', at: '2025-01-01T00:00:00.000Z', nodeId: 'turn.call' }

describe('engine events -> chat frames (the chat surface contract)', () => {
  it('streams content deltas as content frames, chunking intact', () => {
    expect(engineEventToFrame({ ...base, type: 'content', delta: 'Hel' })).toEqual({
      kind: 'frame',
      frame: { type: 'content', delta: 'Hel' },
    })
    expect(engineEventToFrame({ ...base, type: 'content', delta: '' }).kind).toBe('frame')
  })

  it('streams thinking deltas as thinking frames', () => {
    expect(engineEventToFrame({ ...base, type: 'thinking', delta: 'let me' })).toEqual({
      kind: 'frame',
      frame: { type: 'thinking', delta: 'let me' },
    })
  })

  it('maps tool calls to a pill message and the result to the same pill', () => {
    const announced = engineEventToFrame({
      ...base,
      type: 'tool.called',
      callId: 'c1',
      name: 'run_command',
      args: '{"command":"ls"}',
    })
    expect(announced).toEqual({
      kind: 'frame',
      frame: { type: 'toolAnnounce', payload: { id: 'c1', name: 'run_command', args: '{"command":"ls"}' } },
    })
    const resolved = engineEventToFrame({
      ...base,
      type: 'tool.result',
      callId: 'c1',
      ok: false,
      digest: 'the refusal copy verbatim',
    })
    expect(resolved).toEqual({
      kind: 'frame',
      frame: { type: 'toolResult', payload: { id: 'c1', ok: false, digest: 'the refusal copy verbatim' } },
    })
  })

  it('passes usage through as a usage frame', () => {
    expect(
      engineEventToFrame({ ...base, type: 'usage', usage: { input_tokens: 1, output_tokens: 2 } }),
    ).toEqual({ kind: 'frame', frame: { type: 'usage', payload: { input_tokens: 1, output_tokens: 2 } } })
  })

  it('ends the stream on run.finished, keeping the outcome and reason', () => {
    expect(engineEventToFrame({ runId: 'r1', at: base.at, type: 'run.finished', outcome: 'ok' }))
      .toEqual({ kind: 'ended', outcome: 'ok' })
    expect(
      engineEventToFrame({
        runId: 'r1',
        at: base.at,
        type: 'run.finished',
        outcome: 'failed',
        reason: 'the reply hit the token cap',
      }),
    ).toEqual({ kind: 'ended', outcome: 'failed', reason: 'the reply hit the token cap' })
  })

  it('treats an interrupted event as an ended stream carrying the reason', () => {
    expect(engineEventToFrame({ runId: 'r1', at: base.at, type: 'interrupted', reason: 'stopping' }))
      .toEqual({ kind: 'ended', outcome: 'interrupted', reason: 'stopping' })
  })

  it('draws nothing for run mechanics: start, trajectories, model.requested, notice', () => {
    const events: EngineEvent[] = [
      { runId: 'r1', at: base.at, type: 'run.started', agentId: 'koala', loopId: 'p1' },
      { ...base, type: 'node.entered' },
      { ...base, type: 'node.exited', via: 'done' },
      { ...base, type: 'model.requested', toolNames: ['plan'] },
      { ...base, type: 'node.traced', trace: { latencyMs: 4 } },
      { ...base, type: 'notice', level: 'warn', message: 'the approval request' },
      { ...base, type: 'notice', level: 'info', message: 'a machine message' },
    ]
    for (const event of events) {
      expect(engineEventToFrame(event).kind).toBe('idle')
    }
  })
})
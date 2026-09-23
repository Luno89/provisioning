import type { EngineEvent } from '../../api/engine'
import type { UnifiedFrame } from '../../lib/chat-unified-reducer.js'

/**
 * The chat surface renders from UnifiedFrames (see chat-unified-reducer.ts), and the chat turn
 * now rides an engine run whose events come down the ENGINE_EVENT_CHANNEL as EngineEvents.
 * This module is the whole contract between the two: every EngineEvent the reducer can care
 * about,
 * mapped to the frame the chat render state already understands, or ended (the stream source is
 * done), or idle (nothing renders — run mechanics the chat bubbles don't display).
 *
 * Notice events are deliberately not mapped to frames: a warn notice is the engine's approval
 * request, and the hook watches them on the raw event so the approval card can carry the run
 * context the frame wire was never designed to hold.
 */
export type EngineFrameOutcome =
  | { kind: 'frame'; frame: UnifiedFrame }
  | { kind: 'ended'; outcome: string; reason?: string }
  | { kind: 'idle' }

export function engineEventToFrame(event: EngineEvent): EngineFrameOutcome {
  switch (event.type) {
    case 'content':
      return { kind: 'frame', frame: { type: 'content', delta: event.delta } }
    case 'thinking':
      return { kind: 'frame', frame: { type: 'thinking', delta: event.delta } }
    case 'tool.called':
      return {
        kind: 'frame',
        frame: { type: 'toolAnnounce', payload: { id: event.callId, name: event.name, args: event.args } },
      }
    case 'tool.result':
      return {
        kind: 'frame',
        frame: { type: 'toolResult', payload: { id: event.callId, ok: event.ok, digest: event.digest } },
      }
    case 'usage':
      return { kind: 'frame', frame: { type: 'usage', payload: event.usage } }
    case 'interrupted':
      return { kind: 'ended', outcome: 'interrupted', ...(event.reason !== undefined ? { reason: event.reason } : {}) }
    case 'run.finished':
      return { kind: 'ended', outcome: event.outcome, ...(event.reason !== undefined ? { reason: event.reason } : {}) }
    default:
      // run.started, node.entered/exited/traced, model.requested, notice: the chat bubbles do not draw
      return { kind: 'idle' }
  }
}
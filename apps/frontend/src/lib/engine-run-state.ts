import type { EngineEvent } from '../api/engine'

export interface EngineToolCall {
  callId: string
  name: string
  args: string
  running: boolean
  ok?: boolean
  digest?: string
}

export interface EngineRunState {
  runId: string
  agentId?: string
  loopId?: string
  parentRunId?: string
  currentNode?: string | undefined
  visited: string[]
  thinking: string
  content: string
  toolCalls: EngineToolCall[]
  notices: { level: 'info' | 'warn'; message: string }[]
  interruptedReason?: string
  outcome?: string
  outcomeReason?: string
  finished: boolean
}

export const emptyRunState = (runId: string): EngineRunState => ({
  runId,
  visited: [],
  thinking: '',
  content: '',
  toolCalls: [],
  notices: [],
  finished: false,
})

export function reduceEngineEvent(state: EngineRunState, event: EngineEvent): EngineRunState {
  if (event.type === 'run.started') {
    return {
      ...state,
      agentId: event.agentId,
      loopId: event.loopId,
      ...(event.parentRunId ? { parentRunId: event.parentRunId } : {}),
    }
  }

  if (event.type === 'run.finished') {
    return {
      ...state,
      finished: true,
      outcome: event.outcome,
      ...(event.reason ? { outcomeReason: event.reason } : {}),
      currentNode: undefined,
    }
  }

  if (event.type === 'node.entered') {
    return {
      ...state,
      currentNode: event.nodeId,
      visited: state.visited.includes(event.nodeId) ? state.visited : [...state.visited, event.nodeId],
    }
  }

  if (event.type === 'thinking') {
    return { ...state, thinking: state.thinking + event.delta }
  }

  if (event.type === 'content') {
    return { ...state, content: state.content + event.delta }
  }

  if (event.type === 'tool.called') {
    const existing = state.toolCalls.find((call) => call.callId === event.callId)
    if (existing) return state
    return {
      ...state,
      toolCalls: [...state.toolCalls, {
        callId: event.callId,
        name: event.name,
        args: event.args,
        running: true,
      }],
    }
  }

  if (event.type === 'tool.result') {
    return {
      ...state,
      toolCalls: state.toolCalls.map((call) => (call.callId === event.callId
        ? { ...call, running: false, ok: event.ok, digest: event.digest }
        : call)),
    }
  }

  if (event.type === 'notice') {
    return { ...state, notices: [...state.notices, { level: event.level, message: event.message }] }
  }

  if (event.type === 'interrupted') {
    return { ...state, interruptedReason: event.reason }
  }

  return state
}

export function reduceEngineEvents(runId: string, events: EngineEvent[]): EngineRunState {
  return events
    .filter((event) => event.runId === runId)
    .reduce(reduceEngineEvent, emptyRunState(runId))
}

export const pendingApproval = (state: EngineRunState): string | undefined =>
  state.notices.filter((notice) => notice.level === 'warn').at(-1)?.message

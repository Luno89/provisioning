import type { EngineEvent } from '../api/engine'

export interface EngineToolCall {
  callId: string
  name: string
  args: string
  running: boolean
  ok?: boolean
  digest?: string
}

export interface EngineNotice {
  level: 'info' | 'warn'
  message: string
  choices?: string[] | undefined
  callId?: string | undefined
  answered?: boolean | undefined
}

export interface PendingApproval {
  message: string
  callId: string
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
  notices: EngineNotice[]
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

const speakingAt = (state: EngineRunState, nodeId: string): Partial<EngineRunState> =>
  state.finished || state.currentNode === nodeId ? {} : { currentNode: nodeId }

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
      notices: state.notices.map((notice) => (notice.level === 'warn' ? { ...notice, answered: true } : notice)),
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
    return { ...state, ...speakingAt(state, event.nodeId), thinking: state.thinking + event.delta }
  }

  if (event.type === 'content') {
    return { ...state, ...speakingAt(state, event.nodeId), content: state.content + event.delta }
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
      notices: state.notices.map((notice) => (notice.callId === event.callId ? { ...notice, answered: true } : notice)),
    }
  }

  if (event.type === 'notice') {
    const callId = event.level === 'warn' ? event.callId ?? state.toolCalls.filter((call) => call.running).at(-1)?.callId : undefined
    return { ...state, notices: [...state.notices, { level: event.level, message: event.message, ...(event.choices?.length ? { choices: event.choices } : {}), ...(callId ? { callId } : {}) }] }
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

export function pendingApproval(state: EngineRunState): PendingApproval | undefined {
  if (state.finished) return undefined
  const notice = state.notices.filter((candidate) => candidate.level === 'warn' && !candidate.answered).at(-1)
  return notice?.callId ? { message: notice.message, callId: notice.callId } : undefined
}

export function applyTurnEvents(runs: readonly EngineRunState[], events: readonly EngineEvent[]): EngineRunState[] {
  return events.reduce((all: EngineRunState[], event: EngineEvent) => {
    const withRun = all.some((run) => run.runId === event.runId) ? all : [...all, emptyRunState(event.runId)]
    return withRun.map((run) => (run.runId === event.runId ? reduceEngineEvent(run, event) : run))
  }, [...runs])
}

export interface RunInstance extends EngineRunState {
  key: string
  startedAt?: string | undefined
}

export function applyInstanceEvents(instances: readonly RunInstance[], events: readonly EngineEvent[]): RunInstance[] {
  const out = [...instances]
  for (const event of events) {
    if (event.type === 'run.started') {
      out.push({ ...reduceEngineEvent(emptyRunState(event.runId), event), key: `${event.runId}@${event.at}`, startedAt: event.at })
      continue
    }
    let at = -1
    for (let index = out.length - 1; index >= 0; index -= 1) if (out[index]!.runId === event.runId) { at = index; break }
    if (at < 0) {
      out.push({ ...reduceEngineEvent(emptyRunState(event.runId), event), key: `${event.runId}@`, startedAt: undefined })
      continue
    }
    const current = out[at]!
    out[at] = { ...reduceEngineEvent(current, event), key: current.key, startedAt: current.startedAt }
  }
  return out
}

export function instancesUnder(instances: readonly RunInstance[], rootRunId: string, asOf?: string | undefined): RunInstance[] {
  const roots = instances.filter((instance) => instance.runId === rootRunId)
  const root = (asOf ? [...roots].reverse().find((instance) => !instance.startedAt || instance.startedAt <= asOf) : undefined) ?? roots.at(-1)
  if (!root) return []
  const from = root.startedAt ?? ''
  const until = roots.find((instance) => (instance.startedAt ?? '') > from)?.startedAt
  const within = (instance: RunInstance) => (instance.startedAt ?? '') >= from && (until === undefined || (instance.startedAt ?? '') < until)
  const inside = new Set([root.key])
  const ids = new Set([root.runId])
  let grew = true
  while (grew) {
    grew = false
    for (const instance of instances) {
      if (!inside.has(instance.key) && within(instance) && instance.parentRunId && ids.has(instance.parentRunId)) {
        inside.add(instance.key)
        ids.add(instance.runId)
        grew = true
      }
    }
  }
  return instances.filter((instance) => inside.has(instance.key))
}

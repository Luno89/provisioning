import type { EngineEvent } from '../api/engine'

export interface RoundCall {
  callId: string
  name: string
  args: string
  running: boolean
  ok?: boolean | undefined
  digest?: string | undefined
}

export interface Round {
  index: number
  by: 'model' | 'procedure'
  nodeId: string
  model?: string | undefined
  startedAt?: string | undefined
  thinking: string
  content: string
  calls: RoundCall[]
}

const newRound = (index: number, nodeId: string, at?: string, model?: string, by: Round['by'] = 'model'): Round => ({
  index,
  by,
  nodeId,
  ...(at ? { startedAt: at } : {}),
  ...(model ? { model } : {}),
  thinking: '',
  content: '',
  calls: [],
})

export const PROCEDURE_CALL_KIND = 'call-tool'

export function roundsFrom(events: readonly EngineEvent[]): Round[] {
  const steps = new Set(events.flatMap((event) => (event.type === 'node.traced' && event.trace.kind === PROCEDURE_CALL_KIND ? [event.nodeId] : [])))
  const rounds: Round[] = []
  const entered = new Set<string>()
  let spoken = 0
  const open = (nodeId: string, at?: string, model?: string): Round => {
    spoken += 1
    const round = newRound(spoken, nodeId, at, model)
    rounds.push(round)
    entered.delete(nodeId)
    return round
  }
  const lastSpoken = (): Round | undefined => [...rounds].reverse().find((round) => round.by === 'model')
  const speaking = (nodeId: string, at: string): Round => {
    const last = rounds.at(-1)
    if (!last || last.by !== 'model' || last.nodeId !== nodeId || entered.has(nodeId)) return open(nodeId, at)
    return last
  }

  for (const event of events) {
    if (event.type === 'node.entered') {
      entered.add(event.nodeId)
    } else if (event.type === 'model.requested') {
      open(event.nodeId, event.at, event.model)
    } else if (event.type === 'thinking') {
      speaking(event.nodeId, event.at).thinking += event.delta
    } else if (event.type === 'content') {
      speaking(event.nodeId, event.at).content += event.delta
    } else if (event.type === 'tool.called') {
      const call = { callId: event.callId, name: event.name, args: event.args, running: true }
      if (rounds.some((round) => round.calls.some((entry) => entry.callId === event.callId))) continue
      if (steps.has(event.nodeId)) {
        rounds.push({ ...newRound(spoken, event.nodeId, event.at, undefined, 'procedure'), calls: [call] })
        continue
      }
      const round = lastSpoken() ?? open(event.nodeId, event.at)
      round.calls.push(call)
    } else if (event.type === 'tool.result') {
      for (const round of rounds) {
        const call = round.calls.find((entry) => entry.callId === event.callId)
        if (call) {
          call.running = false
          call.ok = event.ok
          call.digest = event.digest
        }
      }
    }
  }
  return rounds
}

export function shownArgs(args: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(args)
  } catch {
    return args
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return JSON.stringify(parsed, null, 2)
  const { command, ...rest } = parsed as Record<string, unknown>
  if (typeof command !== 'string') return JSON.stringify(parsed, null, 2)
  const extra = Object.entries(rest).map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
  return [command, ...extra].join('\n')
}

export function keptForStory(events: readonly EngineEvent[], family: Set<string>): EngineEvent[] {
  const kept: EngineEvent[] = []
  for (const event of events) {
    if (event.type === 'run.started' && event.parentRunId && family.has(event.parentRunId)) family.add(event.runId)
    if (!family.has(event.runId)) continue
    if (event.type !== 'node.traced') {
      kept.push(event)
      continue
    }
    const { kind, error } = event.trace as { kind?: unknown; error?: unknown }
    kept.push({ ...event, trace: { ...(kind !== undefined ? { kind } : {}), ...(error !== undefined ? { error } : {}) } })
  }
  return kept
}

export const instanceKey = (event: EngineEvent): string => `${event.runId}@${event.type === 'run.started' ? event.at : ''}`

export function withInstanceEvents(
  grouped: Readonly<Record<string, EngineEvent[]>>,
  latest: Readonly<Record<string, string>>,
  events: readonly EngineEvent[],
): { grouped: Record<string, EngineEvent[]>; latest: Record<string, string> } {
  const nextGrouped: Record<string, EngineEvent[]> = { ...grouped }
  const nextLatest: Record<string, string> = { ...latest }
  const copied = new Set<string>()
  for (const event of events) {
    if (event.type === 'run.started') nextLatest[event.runId] = instanceKey(event)
    const key = nextLatest[event.runId] ?? `${event.runId}@`
    if (!copied.has(key)) {
      nextGrouped[key] = [...(nextGrouped[key] ?? [])]
      copied.add(key)
    }
    nextGrouped[key]!.push(event)
  }
  return { grouped: nextGrouped, latest: nextLatest }
}

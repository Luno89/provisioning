import type { NodeTrace } from '@koala/agent-engine/procedure'
import type { EngineEvent } from '../api/engine'
import type { GroupPath, StepNodeData } from './procedure-canvas'

export type NodeState = NonNullable<StepNodeData['state']>

export function nodeAtDepth(nodeId: string, path: GroupPath): string | undefined {
  const segments = nodeId.split('.')
  return segments.length > path.length ? segments[path.length] : undefined
}

export function statesFromEvents(events: readonly EngineEvent[], path: GroupPath): Record<string, NodeState> {
  const states: Record<string, NodeState> = {}
  let current: string | undefined
  let finished = false

  for (const event of events) {
    if (event.type === 'node.entered') {
      current = event.nodeId
    } else if (event.type === 'node.exited') {
      const shown = nodeAtDepth(event.nodeId, path)
      if (shown && states[shown] !== 'failed') states[shown] = 'done'
      if (current === event.nodeId) current = undefined
    } else if (event.type === 'node.traced') {
      const shown = nodeAtDepth(event.nodeId, path)
      if (!shown) continue
      if (typeof event.trace.error === 'string') states[shown] = 'failed'
      else if (states[shown] !== 'failed') states[shown] = 'done'
    } else if (event.type === 'run.finished') {
      finished = true
    }
  }

  const running = current && !finished ? nodeAtDepth(current, path) : undefined
  if (running) states[running] = 'running'
  return states
}

export function statesFromTraces(traces: readonly NodeTrace[], path: GroupPath, upTo?: number): Record<string, NodeState> {
  const states: Record<string, NodeState> = {}
  for (const trace of traces) {
    if (upTo !== undefined && trace.sequence > upTo) break
    const shown = nodeAtDepth(trace.node, path)
    if (!shown) continue
    if (trace.error) states[shown] = 'failed'
    else if (states[shown] !== 'failed') states[shown] = 'done'
  }
  const selected = upTo === undefined ? undefined : traces.find((trace) => trace.sequence === upTo)
  const focus = selected ? nodeAtDepth(selected.node, path) : undefined
  if (focus && !selected?.error) states[focus] = 'running'
  return states
}

export function tracesFromEvents(events: readonly EngineEvent[]): NodeTrace[] {
  return events
    .flatMap((event) => (event.type === 'node.traced' ? [event.trace as unknown as NodeTrace] : []))
    .sort((a, b) => a.sequence - b.sequence)
}

export function groupPathOf(nodeId: string, groupOfInstance: (instancePath: readonly string[]) => string | undefined): string[] {
  const segments = nodeId.split('.')
  const path: string[] = []
  for (let depth = 0; depth < segments.length - 1; depth += 1) {
    const group = groupOfInstance(segments.slice(0, depth + 1))
    if (!group) break
    path.push(group)
  }
  return path
}

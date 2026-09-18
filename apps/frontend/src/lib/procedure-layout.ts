import ELK from 'elkjs/lib/elk.bundled.js'
import type { NodeDefinition, Position, Procedure } from '@koala/agent-engine/procedure'
import { bodyAt, definitionOf, moveNodes, type CanvasContext, type GroupPath } from './procedure-canvas'

export const NODE_WIDTH = 240
export const HEADER_HEIGHT = 52
export const SOCKET_ROW = 22
export const EXIT_ROW = 30

export function nodeHeight(definition: NodeDefinition | undefined): number {
  if (!definition) return HEADER_HEIGHT + SOCKET_ROW
  const rows = Math.max(definition.inputs.length, definition.outputs.length, 1)
  return HEADER_HEIGHT + rows * SOCKET_ROW + (definition.exits.length > 0 ? EXIT_ROW : 0) + 8
}

export function freeSpot(taken: readonly (Position & { height: number })[], wanted: Position, gap = 24): Position {
  const spot = { ...wanted }
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const blocking = taken.find((box) =>
      spot.x < box.x + NODE_WIDTH + gap && box.x < spot.x + NODE_WIDTH + gap && spot.y < box.y + box.height + gap && box.y < spot.y + HEADER_HEIGHT + gap)
    if (!blocking) return spot
    spot.y = blocking.y + blocking.height + gap
  }
  return spot
}

const elk = new ELK()

export async function layoutProcedure(procedure: Procedure, path: GroupPath, context: CanvasContext): Promise<Procedure> {
  const body = bodyAt(procedure, path, context)
  if (!body || body.nodes.length === 0) return procedure

  const values = new Set(body.nodes.filter((node) => definitionOf(node, procedure, context)?.role === 'value').map((node) => node.id))
  const reached: string[] = []
  const queue = [body.start, ...(body.cleanup ? [body.cleanup] : [])].filter(Boolean)
  while (queue.length > 0) {
    const id = queue.shift()!
    if (reached.includes(id)) continue
    reached.push(id)
    queue.push(...body.flow.filter((flow) => flow.from === id).map((flow) => flow.to))
  }
  const rank = (id: string) => (reached.includes(id) ? reached.indexOf(id) : reached.length)
  const ordered = [...body.nodes].sort((a, b) => rank(a.id) - rank(b.id))
  const flowInRunOrder = [...body.flow].sort((a, b) => rank(a.from) - rank(b.from))

  const graph = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.spacing.nodeNode': '40',
      'elk.layered.spacing.nodeNodeBetweenLayers': '90',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.layered.cycleBreaking.strategy': 'DEPTH_FIRST',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    },
    children: ordered.map((node) => ({
      id: node.id,
      width: NODE_WIDTH,
      height: nodeHeight(definitionOf(node, procedure, context)),
    })),
    edges: [
      ...flowInRunOrder.map((flow, index) => ({ id: `flow-${index}`, sources: [flow.from], targets: [flow.to] })),
      ...body.wires
        .filter((wire) => values.has(wire.from.node))
        .map((wire, index) => ({ id: `wire-${index}`, sources: [wire.from.node], targets: [wire.to.node] })),
    ],
  })

  const positions: Record<string, Position> = {}
  for (const child of graph.children ?? []) {
    positions[child.id] = { x: child.x ?? 0, y: child.y ?? 0 }
  }
  return moveNodes(procedure, path, positions, context)
}

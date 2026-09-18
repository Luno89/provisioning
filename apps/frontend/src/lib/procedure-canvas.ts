import {
  BUILT_IN_GROUPS,
  GROUP_KIND,
  defaultSettings,
  groupAsNode,
  groupLibrary,
  socketAccepts,
  type Body,
  type Flow,
  type GroupDefinition,
  type NodeCatalogue,
  type NodeDefinition,
  type PlacedNode,
  type Position,
  type Procedure,
  type ProcedureProblem,
  type SocketType,
  type Wire,
} from '@koala/agent-engine/procedure'

export type EditableBody = Body & { cleanup?: string | undefined }

export type GroupPath = readonly string[]

export interface CanvasContext {
  catalogue: NodeCatalogue
  shared?: readonly GroupDefinition[] | undefined
}

export type Refused = { refused: string }

export const isRefused = (value: unknown): value is Refused =>
  typeof value === 'object' && value !== null && 'refused' in value

export const handleId = {
  input: (socket: string) => `in:${socket}`,
  output: (socket: string) => `out:${socket}`,
  exit: (exit: string) => `exit:${exit}`,
  enter: 'enter',
}

export type HandleKind = 'in' | 'out' | 'exit' | 'enter'

export function parseHandle(id: string | null | undefined): { kind: HandleKind; name: string } | undefined {
  if (!id) return undefined
  if (id === handleId.enter) return { kind: 'enter', name: '' }
  const [kind, ...rest] = id.split(':')
  if (kind !== 'in' && kind !== 'out' && kind !== 'exit') return undefined
  return { kind, name: rest.join(':') }
}

export const edgeId = {
  wire: (wire: Wire) => `wire:${wire.from.node}.${wire.from.socket}>${wire.to.node}.${wire.to.socket}`,
  flow: (flow: Flow) => `flow:${flow.from}.${flow.exit}>${flow.to}`,
}

export const libraryOf = (procedure: Procedure, context: CanvasContext) =>
  groupLibrary(procedure, context.shared ?? BUILT_IN_GROUPS)

export function bodyAt(procedure: Procedure, path: GroupPath, context: CanvasContext): EditableBody | undefined {
  if (path.length === 0) return procedure
  const library = libraryOf(procedure, context)
  return library.get(path[path.length - 1]!)
}

export const isEditable = (procedure: Procedure, path: GroupPath): boolean =>
  path.length === 0 || procedure.groups.some((group) => group.id === path[path.length - 1])

function withBody(procedure: Procedure, path: GroupPath, update: (body: EditableBody) => EditableBody): Procedure {
  if (path.length === 0) {
    const { schema, id, version, name, describe, budget, groups } = procedure
    return { schema, id, version, name, describe, budget, groups, ...update(procedure) }
  }
  const groupId = path[path.length - 1]!
  return {
    ...procedure,
    groups: procedure.groups.map((group) => (group.id === groupId ? { ...group, ...update(group) } as GroupDefinition : group)),
  }
}

export function definitionOf(node: PlacedNode, procedure: Procedure, context: CanvasContext): NodeDefinition | undefined {
  if (node.kind === GROUP_KIND) {
    const group = node.group ? libraryOf(procedure, context).get(node.group) : undefined
    return group ? groupAsNode(group) : undefined
  }
  return context.catalogue.get(node.kind)
}

const camel = (kind: string): string =>
  kind.replace(/-([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase())

export function freshNodeId(body: EditableBody, base: string): string {
  const stem = camel(base).replace(/[^a-zA-Z0-9]/g, '') || 'node'
  const taken = new Set(body.nodes.map((node) => node.id))
  if (!taken.has(stem)) return stem
  let counter = 2
  while (taken.has(`${stem}${counter}`)) counter += 1
  return `${stem}${counter}`
}

export interface Connection {
  source: string
  sourceHandle: string | null | undefined
  target: string
  targetHandle: string | null | undefined
}

export function connect(
  procedure: Procedure,
  path: GroupPath,
  connection: Connection,
  context: CanvasContext,
): Procedure | Refused {
  if (!isEditable(procedure, path)) return { refused: 'a built-in group cannot be changed' }
  const body = bodyAt(procedure, path, context)
  if (!body) return { refused: 'that group does not exist' }

  const source = body.nodes.find((node) => node.id === connection.source)
  const target = body.nodes.find((node) => node.id === connection.target)
  const from = parseHandle(connection.sourceHandle)
  const to = parseHandle(connection.targetHandle)
  if (!source || !target || !from || !to) return { refused: 'that connection does not join two nodes' }

  const sourceDefinition = definitionOf(source, procedure, context)
  const targetDefinition = definitionOf(target, procedure, context)
  if (!sourceDefinition || !targetDefinition) return { refused: 'one of those nodes is not a kind of node' }

  if (from.kind === 'out' && to.kind === 'in') {
    const output = sourceDefinition.outputs.find((socket) => socket.name === from.name)
    const input = targetDefinition.inputs.find((socket) => socket.name === to.name)
    if (!output || !input) return { refused: 'one of those sockets does not exist' }
    if (!socketAccepts(input.type, output.type)) {
      return { refused: `${targetDefinition.title} "${input.name}" takes ${input.type}, but ${sourceDefinition.title} "${output.name}" gives ${output.type}` }
    }

    const wire: Wire = { from: { node: source.id, socket: output.name }, to: { node: target.id, socket: input.name } }
    const sameWire = (candidate: Wire) => edgeId.wire(candidate) === edgeId.wire(wire)
    const intoSocket = (candidate: Wire) => candidate.to.node === target.id && candidate.to.socket === input.name
    if (body.wires.some(sameWire)) return procedure

    return withBody(procedure, path, (current) => ({
      ...current,
      wires: [...current.wires.filter((candidate) => input.many || !intoSocket(candidate)), wire],
    }))
  }

  if (from.kind === 'exit' && to.kind === 'enter') {
    if (!sourceDefinition.exits.some((exit) => exit.name === from.name)) return { refused: 'that exit does not exist' }
    if (targetDefinition.role !== 'step') {
      return { refused: `${targetDefinition.title} is a value node — it never runs on its own, so nothing can lead to it` }
    }

    const flow: Flow = { from: source.id, exit: from.name, to: target.id }
    return withBody(procedure, path, (current) => ({
      ...current,
      flow: [...current.flow.filter((candidate) => !(candidate.from === source.id && candidate.exit === from.name)), flow],
    }))
  }

  if ((from.kind === 'out' && to.kind === 'enter') || (from.kind === 'exit' && to.kind === 'in')) {
    return { refused: 'data sockets connect to data sockets, and exits connect to the top of a step' }
  }

  return { refused: 'connect from an output or an exit, into an input or a step' }
}

export function removeEdges(procedure: Procedure, path: GroupPath, ids: readonly string[], context: CanvasContext): Procedure {
  if (!isEditable(procedure, path) || !bodyAt(procedure, path, context)) return procedure
  const gone = new Set(ids)
  return withBody(procedure, path, (body) => ({
    ...body,
    wires: body.wires.filter((wire) => !gone.has(edgeId.wire(wire))),
    flow: body.flow.filter((flow) => !gone.has(edgeId.flow(flow))),
  }))
}

export function addNode(
  procedure: Procedure,
  path: GroupPath,
  kind: string,
  position: Position,
  context: CanvasContext,
  group?: string,
): { procedure: Procedure; id: string } | Refused {
  if (!isEditable(procedure, path)) return { refused: 'a built-in group cannot be changed' }
  const body = bodyAt(procedure, path, context)
  if (!body) return { refused: 'that group does not exist' }

  const library = libraryOf(procedure, context)
  const groupDefinition = kind === GROUP_KIND && group ? library.get(group) : undefined
  if (kind === GROUP_KIND && !groupDefinition) return { refused: `there is no group called "${group ?? ''}"` }
  if (groupDefinition && path.includes(groupDefinition.id)) return { refused: 'a group cannot contain itself' }

  const definition = groupDefinition ? groupAsNode(groupDefinition) : context.catalogue.get(kind)
  if (!definition) return { refused: `"${kind}" is not a kind of node` }

  const id = freshNodeId(body, groupDefinition ? groupDefinition.id : kind)
  const node: PlacedNode = {
    id,
    kind,
    ...(groupDefinition ? { group: groupDefinition.id } : {}),
    settings: defaultSettings(definition.settings),
    position: { x: Math.round(position.x), y: Math.round(position.y) },
  }

  const next = withBody(procedure, path, (current) => ({
    ...current,
    nodes: [...current.nodes, node],
    start: current.start || (definition.role === 'step' ? id : current.start),
  }))
  return { procedure: next, id }
}

export function removeNodes(procedure: Procedure, path: GroupPath, ids: readonly string[], context: CanvasContext): Procedure {
  if (!isEditable(procedure, path) || !bodyAt(procedure, path, context)) return procedure
  const gone = new Set(ids)
  const withoutInterface = path.length === 0 ? procedure : {
    ...procedure,
    groups: procedure.groups.map((group) => (group.id !== path[path.length - 1] ? group : {
      ...group,
      inputs: group.inputs.map((input) => ({ ...input, to: input.to.filter((ref) => !gone.has(ref.node)) })),
      outputs: group.outputs.filter((output) => !gone.has(output.from.node)),
      exits: group.exits.filter((exit) => !gone.has(exit.from.node)),
    })),
  }
  return withBody(withoutInterface, path, (body) => {
    const { cleanup, ...rest } = body
    return {
      ...rest,
      nodes: body.nodes.filter((node) => !gone.has(node.id)),
      wires: body.wires.filter((wire) => !gone.has(wire.from.node) && !gone.has(wire.to.node)),
      flow: body.flow.filter((flow) => !gone.has(flow.from) && !gone.has(flow.to)),
      start: gone.has(body.start) ? '' : body.start,
      ...(cleanup !== undefined && !gone.has(cleanup) ? { cleanup } : {}),
    }
  })
}

export function moveNodes(procedure: Procedure, path: GroupPath, positions: Readonly<Record<string, Position>>, context: CanvasContext): Procedure {
  if (!isEditable(procedure, path) || !bodyAt(procedure, path, context)) return procedure
  return withBody(procedure, path, (body) => ({
    ...body,
    nodes: body.nodes.map((node) => {
      const moved = positions[node.id]
      return moved ? { ...node, position: { x: Math.round(moved.x), y: Math.round(moved.y) } } : node
    }),
  }))
}

export interface NodePatch {
  settings?: Record<string, unknown> | undefined
  label?: string | undefined
  notes?: string | undefined
}

export function updateNode(procedure: Procedure, path: GroupPath, id: string, patch: NodePatch, context: CanvasContext): Procedure {
  if (!isEditable(procedure, path) || !bodyAt(procedure, path, context)) return procedure
  return withBody(procedure, path, (body) => ({
    ...body,
    nodes: body.nodes.map((node) => {
      if (node.id !== id) return node
      const { label: _label, notes: _notes, ...rest } = node
      const label = patch.label !== undefined ? patch.label : node.label
      const notes = patch.notes !== undefined ? patch.notes : node.notes
      return {
        ...rest,
        ...(patch.settings ? { settings: patch.settings } : {}),
        ...(label?.trim() ? { label } : {}),
        ...(notes?.trim() ? { notes } : {}),
      }
    }),
  }))
}

export function setStart(procedure: Procedure, path: GroupPath, id: string, context: CanvasContext): Procedure | Refused {
  const body = bodyAt(procedure, path, context)
  const node = body?.nodes.find((candidate) => candidate.id === id)
  if (!isEditable(procedure, path) || !body || !node) return { refused: 'that node cannot start this procedure' }
  if (definitionOf(node, procedure, context)?.role !== 'step') return { refused: 'only a step can be where a procedure starts' }
  return withBody(procedure, path, (current) => ({ ...current, start: id }))
}

export function setCleanup(procedure: Procedure, id: string | undefined, context: CanvasContext): Procedure | Refused {
  if (id === undefined) {
    const { cleanup: _cleanup, ...rest } = procedure
    return rest
  }
  const node = procedure.nodes.find((candidate) => candidate.id === id)
  if (!node || definitionOf(node, procedure, context)?.role !== 'step') return { refused: 'only a step can be the cleanup' }
  return { ...procedure, cleanup: id }
}

export const SOCKET_COLOURS: Record<SocketType, string> = {
  text: '#7dd3fc',
  messages: '#a78bfa',
  reply: '#f0abfc',
  toolCalls: '#fda4af',
  toolResults: '#fdba74',
  toolSet: '#fcd34d',
  environment: '#86efac',
  memory: '#5eead4',
  persona: '#c4b5fd',
  modelBinding: '#93c5fd',
  json: '#d1d5db',
  any: '#e5e7eb',
}

export interface StepNodeData extends Record<string, unknown> {
  placed: PlacedNode
  definition: NodeDefinition | undefined
  isStart: boolean
  isCleanup: boolean
  problems: ProcedureProblem[]
  exposed: ExposedSockets
  state?: 'running' | 'done' | 'failed' | undefined
}

export interface ExposedSockets {
  inputs: Record<string, string>
  outputs: Record<string, string>
  exits: Record<string, string>
}

export function exposedBy(group: GroupDefinition | undefined, nodeId: string): ExposedSockets {
  const exposed: ExposedSockets = { inputs: {}, outputs: {}, exits: {} }
  if (!group) return exposed
  for (const input of group.inputs) {
    for (const ref of input.to) if (ref.node === nodeId) exposed.inputs[ref.socket] = input.name
  }
  for (const output of group.outputs) if (output.from.node === nodeId) exposed.outputs[output.from.socket] = output.name
  for (const exit of group.exits) if (exit.from.node === nodeId) exposed.exits[exit.from.exit] = exit.name
  return exposed
}

export interface CanvasNode {
  id: string
  type: 'step'
  position: Position
  data: StepNodeData
  selected?: boolean | undefined
}

export interface CanvasEdge {
  id: string
  type: 'wire' | 'flow'
  source: string
  sourceHandle: string
  target: string
  targetHandle: string
  data: { colour: string; label?: string | undefined }
}

export function problemsFor(problems: readonly ProcedureProblem[], path: GroupPath): ProcedureProblem[] {
  const group = path.length === 0 ? undefined : path[path.length - 1]
  return problems.filter((problem) => problem.group === group)
}

export function toCanvas(
  procedure: Procedure,
  path: GroupPath,
  problems: readonly ProcedureProblem[],
  context: CanvasContext,
  states: Readonly<Record<string, StepNodeData['state']>> = {},
): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const body = bodyAt(procedure, path, context)
  if (!body) return { nodes: [], edges: [] }
  const here = problemsFor(problems, path)
  const group = path.length === 0 ? undefined : libraryOf(procedure, context).get(path[path.length - 1]!)

  const nodes: CanvasNode[] = body.nodes.map((placed) => ({
    id: placed.id,
    type: 'step',
    position: placed.position,
    data: {
      placed,
      definition: definitionOf(placed, procedure, context),
      isStart: body.start === placed.id,
      isCleanup: body.cleanup === placed.id,
      problems: here.filter((problem) => problem.node === placed.id),
      exposed: exposedBy(group, placed.id),
      ...(states[placed.id] ? { state: states[placed.id] } : {}),
    },
  }))

  const definitions = new Map(nodes.map((node) => [node.id, node.data.definition]))

  const edges: CanvasEdge[] = [
    ...body.flow.map((flow): CanvasEdge => ({
      id: edgeId.flow(flow),
      type: 'flow',
      source: flow.from,
      sourceHandle: handleId.exit(flow.exit),
      target: flow.to,
      targetHandle: handleId.enter,
      data: { colour: '#e2e8f0', label: flow.exit },
    })),
    ...body.wires.map((wire): CanvasEdge => {
      const type = definitions.get(wire.from.node)?.outputs.find((socket) => socket.name === wire.from.socket)?.type ?? 'any'
      return {
        id: edgeId.wire(wire),
        type: 'wire',
        source: wire.from.node,
        sourceHandle: handleId.output(wire.from.socket),
        target: wire.to.node,
        targetHandle: handleId.input(wire.to.socket),
        data: { colour: SOCKET_COLOURS[type] },
      }
    }),
  ]

  return { nodes, edges }
}

export function stateOfOrigin(nodeId: string): string {
  return nodeId.split('.')[0] ?? nodeId
}

import {
  GROUP_KIND,
  type Flow,
  type GroupDefinition,
  type GroupExit,
  type GroupInput,
  type GroupOutput,
  type PlacedNode,
  type Procedure,
  type SocketRef,
  type Wire,
} from '@koala/agent-engine/procedure'
import {
  bodyAt,
  definitionOf,
  freshNodeId,
  isEditable,
  libraryOf,
  type CanvasContext,
  type EditableBody,
  type GroupPath,
  type Refused,
} from './procedure-canvas'

const refKey = (ref: SocketRef) => JSON.stringify([ref.node, ref.socket])

function uniqueName(taken: Set<string>, base: string): string {
  let name = base
  let counter = 2
  while (taken.has(name)) {
    name = `${base}${counter}`
    counter += 1
  }
  taken.add(name)
  return name
}

function replaceBody(procedure: Procedure, path: GroupPath, body: EditableBody, groups: GroupDefinition[]): Procedure {
  if (path.length === 0) {
    const { cleanup, ...rest } = body
    const { cleanup: _cleanup, ...base } = procedure
    return { ...base, ...rest, ...(cleanup !== undefined ? { cleanup } : {}), groups }
  }
  const groupId = path[path.length - 1]!
  return {
    ...procedure,
    groups: groups.map((group) => (group.id === groupId ? { ...group, start: body.start, nodes: body.nodes, wires: body.wires, flow: body.flow } : group)),
  }
}

export function groupSelection(
  procedure: Procedure,
  path: GroupPath,
  selected: readonly string[],
  context: CanvasContext,
): { procedure: Procedure; groupId: string; nodeId: string } | Refused {
  if (!isEditable(procedure, path)) return { refused: 'a built-in group cannot be changed' }
  const body = bodyAt(procedure, path, context)
  if (!body) return { refused: 'that group does not exist' }

  const inside = new Set(selected.filter((id) => body.nodes.some((node) => node.id === id)))
  if (inside.size === 0) return { refused: 'select the nodes to put in the group first' }
  if (body.cleanup !== undefined && inside.has(body.cleanup)) return { refused: 'the cleanup step cannot go inside a group' }

  const members = body.nodes.filter((node) => inside.has(node.id))
  const roleOf = (node: PlacedNode) => definitionOf(node, procedure, context)?.role
  if (!members.some((node) => roleOf(node) === 'step')) return { refused: 'a group needs at least one step in it' }

  const entries = new Set([
    ...body.flow.filter((flow) => !inside.has(flow.from) && inside.has(flow.to)).map((flow) => flow.to),
    ...(inside.has(body.start) ? [body.start] : []),
  ])
  if (entries.size > 1) {
    return { refused: `a group can only be entered at one step, but ${[...entries].map((id) => `"${id}"`).join(' and ')} are both entered from outside it` }
  }
  const start = [...entries][0] ?? members.find((node) => roleOf(node) === 'step')!.id

  const library = libraryOf(procedure, context)
  const groupId = uniqueName(new Set(library.keys()), 'group')

  const inputs: GroupInput[] = []
  const inputNames = new Set<string>()
  const inputBySource = new Map<string, GroupInput>()
  const outputs: GroupOutput[] = []
  const outputNames = new Set<string>()
  const outputBySource = new Map<string, GroupOutput>()
  const exits: GroupExit[] = []
  const exitNames = new Set<string>()
  const exitBySource = new Map<string, GroupExit>()

  const outerWires: Wire[] = []
  const innerWires: Wire[] = []
  const nodeId = freshNodeId({ ...body, nodes: body.nodes.filter((node) => !inside.has(node.id)) }, groupId)
  const byId = new Map(body.nodes.map((node) => [node.id, node]))

  for (const wire of body.wires) {
    const fromInside = inside.has(wire.from.node)
    const toInside = inside.has(wire.to.node)
    if (fromInside && toInside) {
      innerWires.push(wire)
    } else if (!fromInside && toInside) {
      const source = definitionOf(byId.get(wire.from.node)!, procedure, context)?.outputs.find((socket) => socket.name === wire.from.socket)
      const target = definitionOf(byId.get(wire.to.node)!, procedure, context)?.inputs.find((socket) => socket.name === wire.to.socket)
      let input = inputBySource.get(refKey(wire.from))
      if (!input) {
        input = {
          name: uniqueName(inputNames, wire.to.socket),
          type: source?.type ?? target?.type ?? 'any',
          describe: target?.describe ?? '',
          to: [],
        }
        inputBySource.set(refKey(wire.from), input)
        inputs.push(input)
        outerWires.push({ from: wire.from, to: { node: nodeId, socket: input.name } })
      }
      input.to.push(wire.to)
      if (target?.required) input.required = true
    } else if (fromInside && !toInside) {
      let output = outputBySource.get(refKey(wire.from))
      if (!output) {
        const source = definitionOf(byId.get(wire.from.node)!, procedure, context)?.outputs.find((socket) => socket.name === wire.from.socket)
        output = {
          name: uniqueName(outputNames, wire.from.socket),
          type: source?.type ?? 'any',
          describe: source?.describe ?? '',
          from: wire.from,
        }
        outputBySource.set(refKey(wire.from), output)
        outputs.push(output)
      }
      outerWires.push({ from: { node: nodeId, socket: output.name }, to: wire.to })
    } else {
      outerWires.push(wire)
    }
  }

  const outerFlow: Flow[] = []
  const innerFlow: Flow[] = []
  for (const flow of body.flow) {
    const fromInside = inside.has(flow.from)
    const toInside = inside.has(flow.to)
    if (fromInside && toInside) {
      innerFlow.push(flow)
    } else if (!fromInside && toInside) {
      outerFlow.push({ ...flow, to: nodeId })
    } else if (fromInside && !toInside) {
      const sourceKey = JSON.stringify([flow.from, flow.exit])
      let exit = exitBySource.get(sourceKey)
      if (!exit) {
        const spec = definitionOf(byId.get(flow.from)!, procedure, context)?.exits.find((candidate) => candidate.name === flow.exit)
        exit = { name: uniqueName(exitNames, flow.exit), describe: spec?.describe ?? '', from: { node: flow.from, exit: flow.exit } }
        exitBySource.set(sourceKey, exit)
        exits.push(exit)
      }
      outerFlow.push({ from: nodeId, exit: exit.name, to: flow.to })
    } else {
      outerFlow.push(flow)
    }
  }

  const left = Math.min(...members.map((node) => node.position.x))
  const top = Math.min(...members.map((node) => node.position.y))

  const group: GroupDefinition = {
    id: groupId,
    title: 'Group',
    describe: `${members.length} nodes grouped together`,
    start,
    nodes: members.map((node) => ({ ...node, position: { x: node.position.x - left, y: node.position.y - top } })),
    wires: innerWires,
    flow: innerFlow,
    inputs,
    outputs,
    exits,
  }

  const instance: PlacedNode = { id: nodeId, kind: GROUP_KIND, group: groupId, settings: {}, position: { x: left, y: top } }
  const outer: EditableBody = {
    ...body,
    start: inside.has(body.start) ? nodeId : body.start,
    nodes: [...body.nodes.filter((node) => !inside.has(node.id)), instance],
    wires: outerWires,
    flow: outerFlow,
  }

  return { procedure: replaceBody(procedure, path, outer, [...procedure.groups, group]), groupId, nodeId }
}

export function ungroup(
  procedure: Procedure,
  path: GroupPath,
  instanceId: string,
  context: CanvasContext,
): { procedure: Procedure; nodeIds: string[] } | Refused {
  if (!isEditable(procedure, path)) return { refused: 'a built-in group cannot be changed' }
  const body = bodyAt(procedure, path, context)
  const instance = body?.nodes.find((node) => node.id === instanceId)
  if (!body || !instance) return { refused: 'that node does not exist' }
  if (instance.kind !== GROUP_KIND || !instance.group) return { refused: 'only a group can be ungrouped' }
  const group = libraryOf(procedure, context).get(instance.group)
  if (!group) return { refused: `there is no group called "${instance.group}"` }
  if (body.cleanup === instanceId) return { refused: 'the cleanup step cannot be ungrouped' }

  const others = body.nodes.filter((node) => node.id !== instanceId)
  const renamed = new Map<string, string>()
  const taken: PlacedNode[] = [...others]
  for (const node of group.nodes) {
    const id = freshNodeId({ ...body, nodes: taken }, node.id)
    renamed.set(node.id, id)
    taken.push({ ...node, id })
  }
  const rename = (id: string) => renamed.get(id) ?? id
  const renameRef = (ref: SocketRef): SocketRef => ({ node: rename(ref.node), socket: ref.socket })

  const inlined = group.nodes.map((node) => ({
    ...node,
    id: rename(node.id),
    position: { x: instance.position.x + node.position.x, y: instance.position.y + node.position.y },
  }))

  const wires: Wire[] = [
    ...group.wires.map((wire) => ({ from: renameRef(wire.from), to: renameRef(wire.to) })),
  ]
  for (const wire of body.wires) {
    if (wire.to.node === instanceId) {
      const input = group.inputs.find((candidate) => candidate.name === wire.to.socket)
      for (const target of input?.to ?? []) wires.push({ from: wire.from, to: renameRef(target) })
    } else if (wire.from.node === instanceId) {
      const output = group.outputs.find((candidate) => candidate.name === wire.from.socket)
      if (output) wires.push({ from: renameRef(output.from), to: wire.to })
    } else {
      wires.push(wire)
    }
  }

  const flow: Flow[] = [...group.flow.map((entry) => ({ from: rename(entry.from), exit: entry.exit, to: rename(entry.to) }))]
  for (const entry of body.flow) {
    const from = entry.from === instanceId ? group.exits.find((exit) => exit.name === entry.exit)?.from : undefined
    if (entry.from === instanceId && !from) continue
    flow.push({
      from: from ? rename(from.node) : entry.from,
      exit: from ? from.exit : entry.exit,
      to: entry.to === instanceId ? rename(group.start) : entry.to,
    })
  }

  const outer: EditableBody = {
    ...body,
    start: body.start === instanceId ? rename(group.start) : body.start,
    nodes: [...others, ...inlined],
    wires,
    flow,
  }

  const replaced = replaceBody(procedure, path, outer, procedure.groups)
  const uses = [...replaced.nodes, ...replaced.groups.flatMap((candidate) => candidate.nodes)]
  const groups = uses.some((node) => node.group === group.id)
    ? replaced.groups
    : replaced.groups.filter((candidate) => candidate.id !== group.id)

  return { procedure: { ...replaced, groups }, nodeIds: inlined.map((node) => node.id) }
}

export function updateGroup(
  procedure: Procedure,
  groupId: string,
  patch: { title?: string | undefined; describe?: string | undefined },
): Procedure {
  return {
    ...procedure,
    groups: procedure.groups.map((group) =>
      group.id === groupId
        ? { ...group, ...(patch.title !== undefined ? { title: patch.title } : {}), ...(patch.describe !== undefined ? { describe: patch.describe } : {}) }
        : group,
    ),
  }
}

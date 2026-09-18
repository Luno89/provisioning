import { describe, it, expect } from 'vitest'
import {
  BUILT_IN_GROUPS,
  RESEARCH_V2,
  builtInCatalogue,
  checkProcedure,
  PROCEDURE_SCHEMA,
  type Procedure,
} from '@koala/agent-engine/procedure'
import {
  addNode,
  bodyAt,
  connect,
  edgeId,
  isEditable,
  isRefused,
  moveNodes,
  removeEdges,
  removeNodes,
  setCleanup,
  setStart,
  stateOfOrigin,
  toCanvas,
  updateNode,
  type CanvasContext,
} from './procedure-canvas'

const context: CanvasContext = { catalogue: builtInCatalogue(), shared: BUILT_IN_GROUPS }

const blank = (): Procedure => ({
  schema: PROCEDURE_SCHEMA,
  id: 'fresh',
  version: '1',
  name: 'Fresh',
  describe: '',
  budget: { maxRounds: 3 },
  start: '',
  nodes: [],
  wires: [],
  flow: [],
  groups: [],
})

const add = (procedure: Procedure, kind: string, group?: string) => {
  const added = addNode(procedure, [], kind, { x: 10.4, y: 20.6 }, context, group)
  if (isRefused(added)) throw new Error(added.refused)
  return added
}

const must = (value: Procedure | { refused: string }): Procedure => {
  if (isRefused(value)) throw new Error(value.refused)
  return value
}

describe('adding nodes', () => {
  it('names a node after its kind, keeps names unique, and fills in its default settings', () => {
    const first = add(blank(), 'call-model')
    const second = add(first.procedure, 'call-model')

    expect([first.id, second.id]).toEqual(['callModel', 'callModel2'])
    expect(second.procedure.nodes[0]).toEqual({
      id: 'callModel',
      kind: 'call-model',
      settings: { toolChoice: 'auto', stopOverthinking: true },
      position: { x: 10, y: 21 },
    })
  })

  it('makes the first step added the start, but never a value node', () => {
    const withValue = add(blank(), 'text')
    const withStep = add(withValue.procedure, 'finish')

    expect(withValue.procedure.start).toBe('')
    expect(withStep.procedure.start).toBe('finish')
  })

  it('adds a group as one node carrying the group\'s sockets', () => {
    const { procedure, id } = add(blank(), 'group', 'model-turn')

    expect(procedure.nodes[0]).toMatchObject({ id: 'modelTurn', kind: 'group', group: 'model-turn' })
    expect(toCanvas(procedure, [], [], context).nodes[0]!.data.definition?.exits.map((exit) => exit.name))
      .toEqual(['toolCalls', 'answered', 'truncated', 'empty'])
    expect(id).toBe('modelTurn')
  })

  it('refuses a kind that does not exist, and a group that does not exist', () => {
    expect(addNode(blank(), [], 'teleport', { x: 0, y: 0 }, context)).toEqual({ refused: '"teleport" is not a kind of node' })
    expect(addNode(blank(), [], 'group', { x: 0, y: 0 }, context, 'nowhere')).toEqual({ refused: 'there is no group called "nowhere"' })
  })
})

describe('connecting', () => {
  const twoTexts = () => {
    let procedure = add(blank(), 'text').procedure
    procedure = add(procedure, 'text').procedure
    procedure = add(procedure, 'build-context').procedure
    procedure = add(procedure, 'call-model').procedure
    return add(procedure, 'finish').procedure
  }

  it('wires an output into an input of the same type', () => {
    const wired = must(connect(twoTexts(), [], { source: 'text', sourceHandle: 'out:text', target: 'buildContext', targetHandle: 'in:sections' }, context))

    expect(wired.wires).toEqual([{ from: { node: 'text', socket: 'text' }, to: { node: 'buildContext', socket: 'sections' } }])
  })

  it('refuses a wire between sockets that carry different things, saying what each carries', () => {
    const refused = connect(twoTexts(), [], { source: 'text', sourceHandle: 'out:text', target: 'callModel', targetHandle: 'in:binding' }, context)

    expect(refused).toEqual({ refused: 'Call Model "binding" takes modelBinding, but Text "text" gives text' })
  })

  it('keeps every wire into a socket that takes many, in the order they were made', () => {
    let procedure = twoTexts()
    procedure = must(connect(procedure, [], { source: 'text2', sourceHandle: 'out:text', target: 'buildContext', targetHandle: 'in:sections' }, context))
    procedure = must(connect(procedure, [], { source: 'text', sourceHandle: 'out:text', target: 'buildContext', targetHandle: 'in:sections' }, context))

    expect(procedure.wires.map((wire) => wire.from.node)).toEqual(['text2', 'text'])
  })

  it('replaces the wire into a socket that takes one, rather than leaving two', () => {
    let procedure = twoTexts()
    procedure = must(connect(procedure, [], { source: 'buildContext', sourceHandle: 'out:text', target: 'callModel', targetHandle: 'in:system' }, context))
    procedure = must(connect(procedure, [], { source: 'text', sourceHandle: 'out:text', target: 'callModel', targetHandle: 'in:system' }, context))

    expect(procedure.wires).toEqual([{ from: { node: 'text', socket: 'text' }, to: { node: 'callModel', socket: 'system' } }])
  })

  it('routes an exit to a step, replacing where that exit went before', () => {
    let procedure = twoTexts()
    procedure = must(connect(procedure, [], { source: 'callModel', sourceHandle: 'exit:answered', target: 'finish', targetHandle: 'enter' }, context))
    procedure = must(connect(procedure, [], { source: 'callModel', sourceHandle: 'exit:answered', target: 'callModel', targetHandle: 'enter' }, context))

    expect(procedure.flow).toEqual([{ from: 'callModel', exit: 'answered', to: 'callModel' }])
  })

  it('refuses to route into a value node, and refuses mixing data and flow', () => {
    const procedure = twoTexts()

    expect(connect(procedure, [], { source: 'callModel', sourceHandle: 'exit:answered', target: 'text', targetHandle: 'enter' }, context))
      .toEqual({ refused: 'Text is a value node — it never runs on its own, so nothing can lead to it' })
    expect(connect(procedure, [], { source: 'callModel', sourceHandle: 'exit:answered', target: 'buildContext', targetHandle: 'in:sections' }, context))
      .toEqual({ refused: 'data sockets connect to data sockets, and exits connect to the top of a step' })
  })

  it('refuses any change inside a built-in group', () => {
    expect(isEditable(RESEARCH_V2, ['model-turn'])).toBe(false)
    expect(connect(RESEARCH_V2, ['model-turn'], { source: 'persona', sourceHandle: 'out:prompt', target: 'context', targetHandle: 'in:sections' }, context))
      .toEqual({ refused: 'a built-in group cannot be changed' })
  })
})

describe('editing', () => {
  it('removes a node together with every wire and flow touching it, and clears it as start or cleanup', () => {
    const removed = removeNodes(RESEARCH_V2, [], ['provision', 'release'], context)

    expect(removed.nodes.some((node) => node.id === 'provision')).toBe(false)
    expect(removed.wires.some((wire) => wire.from.node === 'provision')).toBe(false)
    expect(removed.flow.some((flow) => flow.from === 'provision' || flow.to === 'release')).toBe(false)
    expect(removed.start).toBe('')
    expect(removed.cleanup).toBeUndefined()
  })

  it('drops what a group passes in or out of a node removed from inside it', () => {
    const grouped: Procedure = { ...RESEARCH_V2, groups: BUILT_IN_GROUPS.map((group) => ({ ...group, id: `my-${group.id}` })) }
    const removed = removeNodes(grouped, ['my-model-turn'], ['call'], context)
    const group = removed.groups.find((candidate) => candidate.id === 'my-model-turn')!

    expect(group.exits).toEqual([])
    expect(group.outputs.some((output) => output.from.node === 'call')).toBe(false)
    expect(group.inputs.every((input) => input.to.every((ref) => ref.node !== 'call'))).toBe(true)
  })

  it('removes edges by id', () => {
    const wire = RESEARCH_V2.wires[0]!
    const flow = RESEARCH_V2.flow[0]!
    const removed = removeEdges(RESEARCH_V2, [], [edgeId.wire(wire), edgeId.flow(flow)], context)

    expect(removed.wires).toHaveLength(RESEARCH_V2.wires.length - 1)
    expect(removed.flow).toHaveLength(RESEARCH_V2.flow.length - 1)
  })

  it('moves nodes to whole-pixel positions and leaves the rest alone', () => {
    const moved = moveNodes(RESEARCH_V2, [], { turn: { x: 100.7, y: -3.2 } }, context)

    expect(moved.nodes.find((node) => node.id === 'turn')?.position).toEqual({ x: 101, y: -3 })
    expect(moved.nodes.find((node) => node.id === 'conversation')?.position).toEqual(RESEARCH_V2.nodes.find((node) => node.id === 'conversation')?.position)
  })

  it('updates settings, and drops a label or notes that are cleared', () => {
    const labelled = updateNode(RESEARCH_V2, [], 'turn', { label: 'Think', notes: 'the main call' }, context)
    const cleared = updateNode(labelled, [], 'turn', { label: '', settings: { a: 1 } }, context)

    expect(labelled.nodes.find((node) => node.id === 'turn')).toMatchObject({ label: 'Think', notes: 'the main call' })
    expect(cleared.nodes.find((node) => node.id === 'turn')).toMatchObject({ notes: 'the main call', settings: { a: 1 } })
    expect(cleared.nodes.find((node) => node.id === 'turn')?.label).toBeUndefined()
  })

  it('only lets a step be the start or the cleanup', () => {
    expect(must(setStart(RESEARCH_V2, [], 'conversation', context)).start).toBe('conversation')
    expect(setStart(RESEARCH_V2, [], 'input', context)).toEqual({ refused: 'only a step can be where a procedure starts' })
    expect(setCleanup(RESEARCH_V2, 'input', context)).toEqual({ refused: 'only a step can be the cleanup' })
    expect(must(setCleanup(RESEARCH_V2, undefined, context)).cleanup).toBeUndefined()
  })

  it('keeps an edited built-in valid when the edit is harmless', () => {
    const moved = moveNodes(RESEARCH_V2, [], { turn: { x: 5, y: 5 } }, context)

    expect(checkProcedure(moved, { catalogue: context.catalogue, groups: BUILT_IN_GROUPS })).toEqual([])
  })
})

describe('drawing the canvas', () => {
  it('draws every node, flow and wire, marking the start, the cleanup and each node\'s problems', () => {
    const broken = removeEdges(RESEARCH_V2, [], [edgeId.flow(RESEARCH_V2.flow.find((flow) => flow.from === 'turn' && flow.exit === 'empty')!)], context)
    const problems = checkProcedure(broken, { catalogue: context.catalogue, groups: BUILT_IN_GROUPS })
    const { nodes, edges } = toCanvas(broken, [], problems, context, { turn: 'running' })

    expect(nodes).toHaveLength(RESEARCH_V2.nodes.length)
    expect(edges).toHaveLength(RESEARCH_V2.wires.length + RESEARCH_V2.flow.length - 1)
    expect(nodes.find((node) => node.id === 'provision')?.data).toMatchObject({ isStart: true, isCleanup: false })
    expect(nodes.find((node) => node.id === 'release')?.data.isCleanup).toBe(true)
    expect(nodes.find((node) => node.id === 'turn')?.data).toMatchObject({ state: 'running', problems: [expect.objectContaining({ exit: 'empty' })] })
    expect(edges.find((edge) => edge.type === 'flow' && edge.source === 'turn')).toMatchObject({ sourceHandle: 'exit:toolCalls', targetHandle: 'enter' })
    expect(edges.find((edge) => edge.id === 'wire:conversation.messages>turn.messages')?.data.colour).toBe('#a78bfa')
  })

  it('opens a group to draw what is inside it, marking the sockets and exits the group passes in and out', () => {
    const inside = toCanvas(RESEARCH_V2, ['model-turn'], [], context)
    const call = inside.nodes.find((node) => node.id === 'call')!

    expect(bodyAt(RESEARCH_V2, ['model-turn'], context)?.start).toBe('call')
    expect(inside.nodes.map((node) => node.id)).toContain('context')
    expect(call.data.exposed.exits).toMatchObject({ answered: 'answered' })
    expect(toCanvas(RESEARCH_V2, [], [], context).nodes[0]!.data.exposed).toEqual({ inputs: {}, outputs: {}, exits: {} })
  })

  it('lights up the node on the canvas that a node inside a group belongs to', () => {
    expect(stateOfOrigin('turn.call')).toBe('turn')
    expect(stateOfOrigin('finish')).toBe('finish')
  })
})

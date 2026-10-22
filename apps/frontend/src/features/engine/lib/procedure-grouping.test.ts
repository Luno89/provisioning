import { describe, it, expect } from 'vitest'
import {
  BUILT_IN_GROUPS,
  RESEARCH_V2,
  SINGLE_SHOT_V2,
  builtInCatalogue,
  checkProcedure,
  expandGroups,
  groupLibrary,
  type Procedure,
} from '@koala/agent-engine/procedure'
import { isRefused, type CanvasContext } from './procedure-canvas'
import { groupSelection, ungroup, updateGroup } from './procedure-grouping'

const context: CanvasContext = { catalogue: builtInCatalogue(), shared: BUILT_IN_GROUPS }
const problems = (procedure: Procedure) => checkProcedure(procedure, { catalogue: context.catalogue, groups: BUILT_IN_GROUPS })

function runsLike(procedure: Procedure) {
  const { body } = expandGroups(procedure, groupLibrary(procedure, BUILT_IN_GROUPS))
  const bare = (id: string) => id.split('.').at(-1)!
  return {
    start: bare(body.start),
    nodes: body.nodes.map((node) => `${bare(node.id)}:${node.kind}`).sort(),
    wires: body.wires.map((wire) => `${bare(wire.from.node)}.${wire.from.socket}>${bare(wire.to.node)}.${wire.to.socket}`).sort(),
    flow: body.flow.map((flow) => `${bare(flow.from)}.${flow.exit}>${bare(flow.to)}`).sort(),
  }
}

const theModelCall = ['persona', 'model', 'tools', 'environment', 'toolText', 'memory', 'outputs', 'context', 'fit', 'call']

describe('grouping a selection', () => {
  it('turns the selected nodes into one group node that runs exactly as they did', () => {
    const grouped = groupSelection(SINGLE_SHOT_V2, [], theModelCall, context)
    if (isRefused(grouped)) throw new Error(grouped.refused)

    expect(problems(grouped.procedure)).toEqual([])
    expect(runsLike(grouped.procedure)).toEqual(runsLike(SINGLE_SHOT_V2))
    expect(grouped.procedure.nodes.map((node) => node.id)).not.toContain('call')
  })

  it('exposes what crosses the boundary as the group\'s sockets and exits, sharing one input between inside nodes fed by the same thing', () => {
    const grouped = groupSelection(SINGLE_SHOT_V2, [], theModelCall, context)
    if (isRefused(grouped)) throw new Error(grouped.refused)
    const group = grouped.procedure.groups.find((candidate) => candidate.id === grouped.groupId)!

    expect(group.start).toBe('call')
    expect(group.inputs.find((input) => input.name === 'environment')?.to.map((ref) => ref.node).sort()).toEqual(['environment', 'toolText', 'tools'])
    expect(group.exits.map((exit) => exit.name)).toEqual(['toolCalls', 'answered', 'truncated', 'empty'])
    expect(grouped.procedure.wires).toContainEqual({ from: { node: 'provision', socket: 'environment' }, to: { node: 'release', socket: 'environment' } })
  })

  it('refuses a selection entered at two different steps, one holding the cleanup, or one with no step', () => {
    expect(groupSelection(SINGLE_SHOT_V2, [], ['call', 'verdict', 'unavailable'], context))
      .toEqual({ refused: 'a group can only be entered at one step, but "unavailable" and "call" are both entered from outside it' })
    expect(groupSelection(SINGLE_SHOT_V2, [], ['release', 'released'], context))
      .toEqual({ refused: 'the cleanup step cannot go inside a group' })
    expect(groupSelection(SINGLE_SHOT_V2, [], ['persona', 'memory'], context))
      .toEqual({ refused: 'a group needs at least one step in it' })
  })

  it('takes over as the start when the start goes inside', () => {
    const grouped = groupSelection(SINGLE_SHOT_V2, [], ['provision', 'conversation'], context)
    if (isRefused(grouped)) throw new Error(grouped.refused)

    expect(grouped.procedure.start).toBe(grouped.nodeId)
    expect(problems(grouped.procedure)).toEqual([])
    expect(runsLike(grouped.procedure)).toEqual(runsLike(SINGLE_SHOT_V2))
  })
})

describe('ungrouping', () => {
  it('puts a group\'s nodes back exactly as they were, and drops the group once nothing uses it', () => {
    const grouped = groupSelection(SINGLE_SHOT_V2, [], theModelCall, context)
    if (isRefused(grouped)) throw new Error(grouped.refused)
    const back = ungroup(grouped.procedure, [], grouped.nodeId, context)
    if (isRefused(back)) throw new Error(back.refused)

    expect(back.procedure.groups).toEqual([])
    expect(problems(back.procedure)).toEqual([])
    expect(runsLike(back.procedure)).toEqual(runsLike(SINGLE_SHOT_V2))
    expect(back.procedure.nodes.find((node) => node.id === 'call')?.position).toEqual(SINGLE_SHOT_V2.nodes.find((node) => node.id === 'call')?.position)
  })

  it('copies a built-in group\'s nodes out so they can be edited, renaming any that clash', () => {
    const back = ungroup(RESEARCH_V2, [], 'turn', context)
    if (isRefused(back)) throw new Error(back.refused)

    expect(problems(back.procedure)).toEqual([])
    expect(runsLike(back.procedure).flow.length).toBe(runsLike(RESEARCH_V2).flow.length)
    expect(new Set(back.procedure.nodes.map((node) => node.id)).size).toBe(back.procedure.nodes.length)
    expect(back.procedure.nodes.some((node) => node.id === 'turn')).toBe(false)
  })

  it('only ungroups group nodes', () => {
    expect(ungroup(RESEARCH_V2, [], 'provision', context)).toEqual({ refused: 'only a group can be ungrouped' })
  })
})

describe('naming a group', () => {
  it('changes only the group\'s title and description', () => {
    const grouped = groupSelection(SINGLE_SHOT_V2, [], theModelCall, context)
    if (isRefused(grouped)) throw new Error(grouped.refused)
    const named = updateGroup(grouped.procedure, grouped.groupId, { title: 'Ask the model' })

    expect(named.groups[0]).toMatchObject({ title: 'Ask the model', describe: grouped.procedure.groups[0]!.describe })
  })
})

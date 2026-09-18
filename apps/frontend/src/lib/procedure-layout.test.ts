import { describe, it, expect } from 'vitest'
import { BUILT_IN_GROUPS, TOOL_ROUNDS_V2, builtInCatalogue, checkProcedure } from '@koala/agent-engine/procedure'
import { freeSpot, layoutProcedure, nodeHeight, NODE_WIDTH } from './procedure-layout'
import { definitionOf, type CanvasContext } from './procedure-canvas'

const context: CanvasContext = { catalogue: builtInCatalogue(), shared: BUILT_IN_GROUPS }

describe('tidying a procedure\'s layout', () => {
  it('places every node without any two overlapping, and changes nothing but positions', async () => {
    const tidy = await layoutProcedure(TOOL_ROUNDS_V2, [], context)

    const boxes = tidy.nodes.map((node) => ({
      id: node.id,
      x: node.position.x,
      y: node.position.y,
      h: nodeHeight(definitionOf(node, tidy, context)),
    }))
    for (const a of boxes) {
      for (const b of boxes) {
        if (a.id >= b.id) continue
        const overlap = a.x < b.x + NODE_WIDTH && b.x < a.x + NODE_WIDTH && a.y < b.y + b.h && b.y < a.y + a.h
        expect(overlap, `${a.id} overlaps ${b.id}`).toBe(false)
      }
    }

    expect({ ...tidy, nodes: tidy.nodes.map(({ position: _position, ...rest }) => rest) })
      .toEqual({ ...TOOL_ROUNDS_V2, nodes: TOOL_ROUNDS_V2.nodes.map(({ position: _position, ...rest }) => rest) })
    expect(checkProcedure(tidy, { catalogue: context.catalogue, groups: BUILT_IN_GROUPS })).toEqual([])
  })

  it('lays the steps out left to right in the order they run', async () => {
    const tidy = await layoutProcedure(TOOL_ROUNDS_V2, [], context)
    const x = (id: string) => tidy.nodes.find((node) => node.id === id)!.position.x

    expect(x('provision')).toBeLessThan(x('conversation'))
    expect(x('conversation')).toBeLessThan(x('turn'))
  })

  it('makes a node taller the more sockets it has', () => {
    expect(nodeHeight(context.catalogue.get('call-model'))).toBeGreaterThan(nodeHeight(context.catalogue.get('text')))
  })

  it('places a new node below whatever is already where it was asked for', () => {
    const taken = [{ x: 0, y: 0, height: 100 }, { x: 0, y: 124, height: 80 }]

    expect(freeSpot(taken, { x: 10, y: 10 })).toEqual({ x: 10, y: 228 })
    expect(freeSpot(taken, { x: 600, y: 10 })).toEqual({ x: 600, y: 10 })
  })
})

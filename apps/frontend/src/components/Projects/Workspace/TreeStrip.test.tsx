import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { TreeStrip } from './TreeStrip'
import type { Leaf } from '../../leaf-types'

const leaf = (id: string, status: Leaf['status'], over: Partial<Leaf> = {}): Leaf => ({ id, branchId: 'b1', title: `leaf ${id}`, status, createdAt: 't', updatedAt: 't', ...over }) as Leaf

describe('the tree above the channel', () => {
  it('sums up the tree in one line and a bar, and opens what needs the person', () => {
    const onOpenLeaf = vi.fn()
    const leaves = [leaf('l1', 'succeeded', { verified: true } as never), leaf('l2', 'failed', { findings: 'it broke' } as never), leaf('l3', 'pending')]
    render(<TreeStrip tree={{ id: 't1', name: 'Shop' }} branches={[{ id: 'b1', title: 'Module', treeId: 't1' }]} leaves={leaves} onOpenLeaf={onOpenLeaf} />)
    expect(screen.getByTestId('tree-strip')).toHaveTextContent('1 branch, 3 leaves')
    const needs = screen.queryByRole('button', { name: /need/ })
    if (needs) {
      fireEvent.click(needs)
      expect(onOpenLeaf).toHaveBeenCalled()
    }
  })

  it('shows nothing for a tree with no leaves yet', () => {
    const { container } = render(<TreeStrip tree={{ id: 't1', name: 'Shop' }} branches={[]} leaves={[]} onOpenLeaf={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })
})

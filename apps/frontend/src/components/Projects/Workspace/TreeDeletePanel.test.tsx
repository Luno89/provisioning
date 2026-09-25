import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { TreeDeletePanel } from './TreeDeletePanel.js'
import * as groveApi from '../../../api/grove.js'

vi.mock('../../../api/grove.js', async (importOriginal) => ({
  ...(await importOriginal<typeof groveApi>()),
  deleteTree: vi.fn(),
}))

describe('TreeDeletePanel', () => {
  it('asks before deleting, says what goes, and leaves the page once the tree is gone', async () => {
    vi.mocked(groveApi.deleteTree).mockResolvedValue({ success: true })
    const onDeleted = vi.fn()
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TreeDeletePanel treeId="t1" treeName="Greeter" onDeleted={onDeleted} />
      </QueryClientProvider>,
    )

    fireEvent.click(screen.getByText('Delete this tree'))
    expect(screen.getByText(/Delete “Greeter” with its branches, leaves, tasks, plans, conversations and sandbox/)).toBeTruthy()
    expect(groveApi.deleteTree).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('Delete tree'))
    await waitFor(() => expect(onDeleted).toHaveBeenCalled())
    expect(groveApi.deleteTree).toHaveBeenCalledWith('t1')
  })

  it('keeps the tree when told to', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TreeDeletePanel treeId="t1" treeName="Greeter" onDeleted={vi.fn()} />
      </QueryClientProvider>,
    )
    fireEvent.click(screen.getByText('Delete this tree'))
    fireEvent.click(screen.getByText('Keep'))
    expect(screen.getByText('Delete this tree')).toBeTruthy()
  })
})

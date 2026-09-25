import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { TreeConversationsPanel } from './TreeConversationsPanel.js'
import * as chatPackApi from '../../../api/chat-pack.js'

vi.mock('../../../api/chat-pack.js', async (importOriginal) => ({
  ...(await importOriginal<typeof chatPackApi>()),
  listChatConversations: vi.fn(),
}))

describe('TreeConversationsPanel', () => {
  it('lists only the conversations about this tree, and opens or starts one', async () => {
    vi.mocked(chatPackApi.listChatConversations).mockResolvedValue([
      { id: 'c1', title: 'Add metrics', treeId: 't1' },
      { id: 'c2', title: 'Elsewhere', treeId: 't2' },
      { id: 'c3', title: 'Unbound' },
    ])
    const onSelect = vi.fn()
    const onNew = vi.fn()
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <TreeConversationsPanel treeId="t1" selected={{ kind: 'tree', id: 't1' }} onSelect={onSelect} onNew={onNew} />
      </QueryClientProvider>,
    )

    fireEvent.click(await screen.findByText('Add metrics'))
    expect(onSelect).toHaveBeenCalledWith('c1')
    expect(screen.queryByText('Elsewhere')).toBeNull()
    expect(screen.queryByText('Unbound')).toBeNull()
    fireEvent.click(screen.getByText('New conversation'))
    expect(onNew).toHaveBeenCalled()
  })
})

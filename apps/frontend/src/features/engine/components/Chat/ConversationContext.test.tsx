import { render, screen, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ConversationContext } from './ConversationContext'
import * as chatPackApi from '../../api/chat-pack'

vi.mock('../../api/chat-pack', async (orig) => ({ ...(await orig<typeof chatPackApi>()), getConversationContext: vi.fn() }))

const renderContext = (channel = false) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ConversationContext conversationId="story-l1" channel={channel} />
  </QueryClientProvider>,
)

const story = 'Story "Module installs" (l1), in the feature "The field" (b1) of tree "Shop" (t1).\nState: failed.\nTasks:\n  - Write the view [running] — done means: it shows'
const text = `treeId: t1\n\nleafId: l1\n\nstory: ${story}`

describe('what Koala sees, shown in the chat', () => {
  it('is formatted for reading, with the ids it is given set aside', async () => {
    vi.mocked(chatPackApi.getConversationContext).mockResolvedValue({ given: { treeId: 't1', leafId: 'l1', story }, text })
    renderContext()
    expect(await screen.findByText(/What Koala sees about this story, added to every message you send here$/)).toBeInTheDocument()
    const part = screen.getByRole('region', { name: 'Story' })
    expect(within(part).getByText('State:').tagName).toBe('STRONG')
    expect(within(part).getByRole('listitem')).toHaveTextContent('Write the view [running] — done means: it shows')
    expect(screen.getByText('l1', { selector: 'p > span > code' })).toBeInTheDocument()
    expect(screen.queryByTestId('context-exact')).not.toBeInTheDocument()
  })

  it('shows exactly what is sent when asked, word for word', async () => {
    vi.mocked(chatPackApi.getConversationContext).mockResolvedValue({ given: { treeId: 't1', leafId: 'l1', story }, text })
    renderContext()
    fireEvent.click(await screen.findByRole('button', { name: 'Show exactly as sent' }))
    expect(screen.getByTestId('context-exact').textContent).toBe(text)
    fireEvent.click(screen.getByRole('button', { name: 'Show it formatted' }))
    expect(screen.getByRole('region', { name: 'Story' })).toBeInTheDocument()
  })

  it('says it goes that goes to Koala in a channel, and is absent when the conversation is about nothing', async () => {
    vi.mocked(chatPackApi.getConversationContext).mockResolvedValue({ given: { projectId: 'p1', project: 'Project "Shop" (p1).' }, text: 'projectId: p1\n\nproject: Project "Shop" (p1).' })
    const { unmount } = renderContext(true)
    expect(await screen.findByText(/about this project, added to every message you send here that goes to Koala/)).toBeInTheDocument()
    unmount()
    vi.mocked(chatPackApi.getConversationContext).mockResolvedValue({ given: {}, text: '' })
    renderContext()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(screen.queryByTestId('conversation-context')).not.toBeInTheDocument()
  })
})

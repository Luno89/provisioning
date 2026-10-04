import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import McpToolKinds from './McpToolKinds'
import type { McpServerSummary } from '../../api/mcp'

vi.mock('../../api/mcp', async () => {
  const actual = await vi.importActual<typeof import('../../api/mcp')>('../../api/mcp')
  return { ...actual, listMcpServers: vi.fn(), setMcpToolHint: vi.fn() }
})

const { listMcpServers, setMcpToolHint } = await import('../../api/mcp')

const servers = (choice: 'server' | 'read-only' = 'server'): McpServerSummary[] => [
  {
    name: 'Gitea MCP',
    tools: [
      { name: 'list_repositories', readOnly: choice === 'read-only', kind: choice === 'read-only' ? 'read-only' : 'destructive', declared: 'destructive', choice },
    ],
  },
  { name: 'Docs', tools: [], unreachable: 'timeout' },
]

const show = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><McpToolKinds /></QueryClientProvider>)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(listMcpServers).mockResolvedValue(servers())
})

describe('what each service tool does', () => {
  it('shows what the server says about each tool, and leaves out a server that is not answering', async () => {
    show()

    const choice = await screen.findByRole('combobox', { name: 'What list_repositories does' })
    expect(choice).toHaveValue('server')
    expect(screen.getByRole('option', { name: 'as the server says: can destroy — asks you first' })).toBeInTheDocument()
    expect(screen.queryByText('Docs')).not.toBeInTheDocument()
  })

  it('saves the person\'s word on a tool and shows it back', async () => {
    vi.mocked(setMcpToolHint).mockResolvedValue(servers('read-only'))
    show()

    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'What list_repositories does' }), 'read-only')

    expect(setMcpToolHint).toHaveBeenCalledWith('Gitea MCP', 'list_repositories', 'read-only')
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'What list_repositories does' })).toHaveValue('read-only'))
  })
})

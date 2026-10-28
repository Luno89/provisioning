import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import ProjectMcpServers from './ProjectMcpServers'
import * as mcpApi from '../api/mcp'

vi.mock('../api/mcp', async (orig) => ({
  ...(await orig<typeof mcpApi>()),
  getMcpCatalogue: vi.fn(async () => ({
    templates: [],
    servers: [
      { id: 's1', name: 'notion', runs: { where: 'hosted', url: 'https://mcp.notion.com' }, projects: ['p1'], status: { state: 'captured', tools: 3 }, createdAt: 'a', updatedAt: 'a' },
      { id: 's2', name: 'github', runs: { where: 'hosted', url: 'https://mcp.github.com' }, status: { state: 'captured', tools: 3 }, createdAt: 'a', updatedAt: 'a' },
      { id: 's3', name: 'playwright', runs: { where: 'workspace', needs: [], start: 'serve', port: 8931 }, status: { state: 'captured', tools: 3 }, createdAt: 'a', updatedAt: 'a' },
    ],
  })),
  saveMcpServer: vi.fn(async () => ({})),
}))

const mount = () => render(<QueryClientProvider client={new QueryClient()}><ProjectMcpServers projectId="p1" /></QueryClientProvider>)

describe('the MCP servers a project lets its people reach', () => {
  it('lists the hosted servers with the attached ones checked, and names the workspace ones as reached without attaching', async () => {
    mount()
    expect(await screen.findByLabelText(/notion/)).toBeChecked()
    expect(screen.getByLabelText(/github/)).not.toBeChecked()
    expect(screen.getByText(/playwright run inside the project's workspace/)).toBeInTheDocument()
  })

  it('attaches and detaches a server by saving its projects', async () => {
    mount()
    fireEvent.click(await screen.findByLabelText(/github/))
    await waitFor(() => expect(mcpApi.saveMcpServer).toHaveBeenCalledWith('s2', { projects: ['p1'] }))
    fireEvent.click(screen.getByLabelText(/notion/))
    await waitFor(() => expect(mcpApi.saveMcpServer).toHaveBeenCalledWith('s1', { projects: [] }))
  })
})

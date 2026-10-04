import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import McpServersMenu from './McpServersMenu'

const servers = [
  { name: 'Gitea MCP', tools: [{ name: 'list_repos', readOnly: true, kind: 'read-only' as const, declared: 'read-only' as const, choice: 'server' as const }] },
  { name: 'Docs', tools: [], unreachable: 'timeout' },
]

describe('McpServersMenu', () => {
  it('switches a server on and off for the conversation', () => {
    const onChoose = vi.fn()
    const { rerender } = render(<McpServersMenu servers={servers} enabled={[]} busy={false} onChoose={onChoose} />)
    fireEvent.click(screen.getByRole('button', { name: 'MCP servers for this conversation' }))
    expect(screen.getByText('not answering — timeout')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: /Gitea MCP/ }))
    expect(onChoose).toHaveBeenLastCalledWith(['Gitea MCP'])

    rerender(<McpServersMenu servers={servers} enabled={['Gitea MCP']} busy={false} onChoose={onChoose} />)
    fireEvent.click(screen.getByRole('checkbox', { name: /Gitea MCP/ }))
    expect(onChoose).toHaveBeenLastCalledWith([])
  })

  it('does not show at all when the person runs no servers', () => {
    const { container } = render(<McpServersMenu servers={[]} enabled={[]} busy={false} onChoose={() => {}} />)
    expect(container).toBeEmptyDOMElement()
  })
})

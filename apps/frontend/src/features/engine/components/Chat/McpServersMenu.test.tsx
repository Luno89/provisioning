import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import McpServersMenu from './McpServersMenu'

const servers = [
  { name: 'gitea', tools: [{ name: 'list_repos', readOnly: true, kind: 'read-only' as const, declared: 'read-only' as const }] },
  { name: 'docs', tools: [] },
]

describe('McpServersMenu', () => {
  it('switches a server on and off for the conversation', () => {
    const onChoose = vi.fn()
    const { rerender } = render(<McpServersMenu servers={servers} enabled={[]} busy={false} onChoose={onChoose} />)
    fireEvent.click(screen.getByRole('button', { name: 'MCP servers for this conversation' }))
    expect(screen.getByText('1 tool')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: /gitea/ }))
    expect(onChoose).toHaveBeenLastCalledWith(['gitea'])

    rerender(<McpServersMenu servers={servers} enabled={['gitea']} busy={false} onChoose={onChoose} />)
    fireEvent.click(screen.getByRole('checkbox', { name: /gitea/ }))
    expect(onChoose).toHaveBeenLastCalledWith([])
  })

  it('does not show at all when the person runs no servers', () => {
    const { container } = render(<McpServersMenu servers={[]} enabled={[]} busy={false} onChoose={() => {}} />)
    expect(container).toBeEmptyDOMElement()
  })
})

import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import type { McpRequest } from '@koala/harness-types'
import McpRequestCard from './McpRequestCard'

const request = (over: Partial<McpRequest> = {}): McpRequest => ({
  id: 'q1', ownerId: 'u1', conversationId: 'c1', server: 'Gitea MCP', why: 'to read the repo', status: 'requested', createdAt: 'x', updatedAt: 'x', ...over,
})

describe('McpRequestCard', () => {
  it('shows what koala wants and why, and switches it on or dismisses', () => {
    const onEnable = vi.fn()
    const onDismiss = vi.fn()
    render(<McpRequestCard request={request()} busy={false} onEnable={onEnable} onDismiss={onDismiss} />)
    expect(screen.getByText('Gitea MCP')).toBeInTheDocument()
    expect(screen.getByText('to read the repo')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Switch it on' }))
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(onEnable).toHaveBeenCalledTimes(1)
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('offers nothing once decided', () => {
    render(<McpRequestCard request={request({ status: 'enabled' })} busy={false} onEnable={() => {}} onDismiss={() => {}} />)
    expect(screen.getByText('Switched on for this conversation')).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
  })
})

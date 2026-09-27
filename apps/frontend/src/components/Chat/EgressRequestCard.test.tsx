import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import EgressRequestCard from './EgressRequestCard'
import AccessRequestCard from './AccessRequestCard'

describe('EgressRequestCard', () => {
  it('names the host and who wants it, and allows or dismisses', () => {
    const onAllow = vi.fn()
    render(<EgressRequestCard request={{ id: 'e', ownerId: 'u', agentSlug: 'executor', host: 'api.stripe.com', why: 'tests', status: 'requested', createdAt: 'x', updatedAt: 'x' }} busy={false} onAllow={onAllow} onDismiss={() => {}} />)
    expect(screen.getByText('api.stripe.com')).toBeInTheDocument()
    expect(screen.getByText(/only for executor/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
    expect(onAllow).toHaveBeenCalled()
  })
})

describe('AccessRequestCard', () => {
  it('names the namespaces and grants', () => {
    const onGrant = vi.fn()
    render(<AccessRequestCard request={{ id: 'a', ownerId: 'u', conversationId: 'c', namespaces: ['monitoring', 'gitea'], why: 'prometheus', status: 'requested', createdAt: 'x', updatedAt: 'x' }} busy={false} onGrant={onGrant} onDismiss={() => {}} />)
    expect(screen.getByText('monitoring, gitea')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open them' }))
    expect(onGrant).toHaveBeenCalled()
  })
})

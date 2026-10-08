import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ChatApprovalCard from './ChatApprovalCard'

describe('asking the person before a tool runs', () => {
  it('says allowing a tool here stands for the rest of the conversation', async () => {
    const onAllow = vi.fn()
    render(<ChatApprovalCard reason="check-writer wants to run update_check on this run" toolName="update_check" args='{"check":{}}' onAllow={onAllow} onDeny={vi.fn()} />)

    expect(screen.getByText('Allowing it here means update_check will not ask again in this conversation.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Allow in this chat' }))
    expect(onAllow).toHaveBeenCalled()
  })

  it('promises nothing it cannot keep when it does not know the tool', () => {
    render(<ChatApprovalCard reason="a run wants to do something" onAllow={vi.fn()} onDeny={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Allow' })).toBeInTheDocument()
    expect(screen.queryByText(/will not ask again/)).toBeNull()
  })
})

import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ChatApprovalCard from './ChatApprovalCard'

describe('asking the person before a tool runs', () => {
  it('offers every way to allow it, each its own decision', async () => {
    const onDecide = vi.fn()
    render(<ChatApprovalCard reason="research wants to run koala_search_web on OZ-001TallGeese: search" toolName="koala_search_web" onDecide={onDecide} />)

    for (const [name, decision] of [
      ['Allow', 'allow'],
      ['Allow for this run', 'allow-for-run'],
      ['Allow koala_search_web in this chat', 'allow-in-chat'],
      ['Auto mode for this chat', 'auto-chat'],
      ['Deny', 'decline'],
    ] as const) {
      await userEvent.click(screen.getByRole('button', { name }))
      expect(onDecide).toHaveBeenLastCalledWith(decision)
    }
  })

  it('offers no chat-wide allow when it does not know the tool, and still offers auto mode for the chat', () => {
    render(<ChatApprovalCard reason="a run wants to do something" onDecide={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Auto mode for this chat' })).toHaveAttribute('title', expect.stringContaining('nothing it runs asks again, any command or tool'))
    expect(screen.queryByRole('button', { name: /in this chat/ })).toBeNull()
  })
})

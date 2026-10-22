import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { ChatHeader } from './ChatHeader'

const conversations = [{ id: 'a', title: 'First' }, { id: 'b', title: 'Second' }]

describe('the chat header', () => {
  it('lets you switch conversations when it is given somewhere to switch to', () => {
    const onSelectConversation = vi.fn()
    render(<ChatHeader conversations={conversations as never} activeConversation={conversations[0] as never} selectedConvId="a" onSelectConversation={onSelectConversation} />)
    fireEvent.click(screen.getByRole('button', { name: 'First' }))
    fireEvent.click(screen.getByRole('button', { name: /Second/ }))
    expect(onSelectConversation).toHaveBeenCalledWith('b')
  })

  it('offers no switching and no new chat in a channel, which is one conversation', () => {
    render(<ChatHeader conversations={conversations as never} activeConversation={conversations[0] as never} selectedConvId="a" />)
    expect(screen.queryByRole('button', { name: 'First' })).not.toBeInTheDocument()
    expect(screen.queryByText('New Chat')).not.toBeInTheDocument()
  })
})

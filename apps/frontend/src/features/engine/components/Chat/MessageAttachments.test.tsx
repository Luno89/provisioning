import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import MessageAttachments from './MessageAttachments'

describe('the files on a sent message', () => {
  it('each link to its download, from the chat\'s folder in its project or the chat\'s own files', () => {
    render(<MessageAttachments conversationId="c1" attachments={[
      { fileId: 'f1', name: 'brief.pdf', size: 2048, project: { id: 'p1', name: 'Shop' } },
      { fileId: 'f2', name: 'x.png' },
    ]} />)
    expect(screen.getByRole('link', { name: /brief\.pdf/ })).toHaveAttribute('href', expect.stringContaining('/files/projects/p1/content?path=chats%2Fc1%2Fbrief.pdf'))
    expect(screen.getByRole('link', { name: /x\.png/ })).toHaveAttribute('href', expect.stringContaining('/files/conversations/c1/content?path=x.png'))
    expect(screen.getByText('2.0 KB')).toBeInTheDocument()
  })

  it('says one from before files had ids is no longer available, with no link', () => {
    render(<MessageAttachments conversationId="c1" attachments={[{ name: 'old.png', path: 'chats/2026-10-21/100309-old.png', size: 10 }]} />)
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByTitle('old.png: no longer available')).toHaveTextContent('no longer available')
  })

  it('links nothing where the chat is not known', () => {
    render(<MessageAttachments attachments={[{ fileId: 'f1', name: 'x.png' }]} />)
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByTitle('x.png: cannot be opened here')).toBeInTheDocument()
  })
})

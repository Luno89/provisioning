import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import MessageAttachments from './MessageAttachments'

describe('the files on a sent message', () => {
  it('each link to its download, from the project\'s files or the person\'s own', () => {
    render(<MessageAttachments attachments={[
      { name: 'brief.pdf', path: 'attachments/2026-10-21/100309-brief.pdf', size: 2048, project: { id: 'p1', name: 'Shop' } },
      { name: 'x.png', path: 'chats/2026-10-21/100309-x.png' },
    ]} />)
    expect(screen.getByRole('link', { name: /brief\.pdf/ })).toHaveAttribute('href', expect.stringContaining('/files/projects/p1/content?path=attachments%2F2026-10-21%2F100309-brief.pdf'))
    expect(screen.getByRole('link', { name: /x\.png/ })).toHaveAttribute('href', expect.stringContaining('/files/mine/content?path=chats%2F2026-10-21%2F100309-x.png'))
    expect(screen.getByText('2.0 KB')).toBeInTheDocument()
  })
})

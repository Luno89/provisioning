import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, params, children, className }: { to: string; params: { name: string }; children: React.ReactNode; className?: string }) => <a href={to.replace('$name', params.name)} className={className}>{children}</a>,
}))

import ImageContents from './ImageContents'

describe('what an image has, and why', () => {
  it('lists each dependency with every reason, linked to its page, and marks what the base already has', () => {
    render(<ImageContents empty="none" contents={[
      { dependency: 'koala-e2e', why: ['step:Run Browser Tests'], installed: true },
      { dependency: 'python', why: ['tool:json_query'], installed: false },
    ]} />)
    expect(screen.getByText('koala-e2e')).toHaveAttribute('href', '/studio/dependencies/koala-e2e')
    expect(screen.getByText('because of the step Run Browser Tests')).toBeInTheDocument()
    expect(screen.getByText('in the base')).toBeInTheDocument()
  })

  it('says why it is empty', () => {
    render(<ImageContents empty="Nothing on top of the base." contents={[]} />)
    expect(screen.getByText('Nothing on top of the base.')).toBeInTheDocument()
  })
})

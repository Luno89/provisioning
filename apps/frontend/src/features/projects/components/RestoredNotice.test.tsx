import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { RestoredNotice } from './RestoredNotice'
import { useDeletionsStore } from '../stores/deletions'

describe('a restored project\'s page', () => {
  beforeEach(() => { useDeletionsStore.setState({ followed: [], restored: {} }) })

  it('says what did not come back and names the secrets to enter again', () => {
    useDeletionsStore.setState({ restored: { p1: { name: 'shop', renamed: false, secrets: ['STRIPE_KEY', 'SMTP_PASSWORD'] } } })
    render(<RestoredNotice projectId="p1" />)
    expect(screen.getByText('Its apps and secrets were deleted; deploy again to run it.')).toBeInTheDocument()
    expect(screen.getByText('Enter its secrets again: STRIPE_KEY, SMTP_PASSWORD')).toBeInTheDocument()
    expect(screen.queryByText(/is back as/)).not.toBeInTheDocument()
  })

  it('says it came back under a new name when its name was taken, and goes when dismissed', () => {
    useDeletionsStore.setState({ restored: { p1: { name: 'shop (restored)', renamed: true, secrets: [] } } })
    render(<RestoredNotice projectId="p1" />)
    expect(screen.getByText('A project of its name exists now, so it is back as “shop (restored)”.')).toBeInTheDocument()
    expect(screen.queryByText(/Enter its secrets again/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(useDeletionsStore.getState().restored).toEqual({})
  })

  it('shows nothing on a project that was not just restored', () => {
    const { container } = render(<RestoredNotice projectId="p2" />)
    expect(container).toBeEmptyDOMElement()
  })
})

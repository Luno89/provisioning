import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import RunEnded from './RunEnded'

describe('how a run ended, at the top of its page', () => {
  it('shows nothing while the run has not ended', () => {
    const { container } = render(<RunEnded ending={undefined} />)
    expect(container.textContent).toBe('')
  })

  it('shows a failed run\'s reason, and no handover', () => {
    render(<RunEnded ending={{ runId: 'run-1', ended: { how: 'failed', reason: 'the model went away', at: 't' } }} />)
    expect(screen.getByTestId('run-ended').textContent).toBe('Failed: the model went away')
    expect(screen.queryByTestId('handover-note')).not.toBeInTheDocument()
  })

  it('says a revoked run could not leave a note, and why', () => {
    render(<RunEnded ending={{ runId: 'run-1', ended: { how: 'revoked', revokedBecause: 'account-removed', at: 't' }, handover: { failed: 'its model did not answer' } }} />)
    expect(screen.getByTestId('run-ended').textContent).toContain('their account is being removed')
    expect(screen.getByTestId('run-ended').textContent).toContain('It could not leave a handover note: its model did not answer.')
  })
})

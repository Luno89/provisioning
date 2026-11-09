import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ValidationNote } from './ValidationNote'

describe('what a credential check says', () => {
  it('tells credentials that work, ones that were refused, and a check that could not be made apart', () => {
    const { rerender } = render(<ValidationNote result={{ valid: true, message: 'Authenticated as Hugging Face user @me' }} />)
    expect(screen.getByRole('status')).toHaveAttribute('data-state', 'valid')
    rerender(<ValidationNote result={{ valid: false, message: 'Invalid token or unauthorized (HTTP 401).' }} />)
    expect(screen.getByRole('status')).toHaveAttribute('data-state', 'invalid')
    rerender(<ValidationNote result={{ valid: false, unchecked: true, message: 'Hugging Face could not check these credentials just now: it answered 503' }} />)
    expect(screen.getByRole('status')).toHaveAttribute('data-state', 'unchecked')
    expect(screen.getByRole('status')).toHaveTextContent('Hugging Face could not check these credentials just now: it answered 503')
  })
})

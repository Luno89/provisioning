import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import type { SecretRequest } from '@koala/harness-types'
import SecretRequestCard from './SecretRequestCard'

const request = (over: Partial<SecretRequest> = {}): SecretRequest => ({
  id: 'r1',
  ownerId: 'u1',
  projectId: 'p1',
  key: 'STRIPE_API_KEY',
  description: 'The live key, from the Stripe dashboard.',
  secretReference: 'secret://p1/STRIPE_API_KEY',
  status: 'requested',
  createdAt: 'now',
  updatedAt: 'now',
  ...over,
})

describe('SecretRequestCard', () => {
  it('takes the value in a masked field, hands it over once, and clears it after it is saved', () => {
    const onSubmit = vi.fn((_value: string, done: () => void) => done())
    render(<SecretRequestCard request={request()} busy={false} onSubmit={onSubmit} onDismiss={() => {}} />)

    const field = screen.getByLabelText('Value for STRIPE_API_KEY') as HTMLInputElement
    expect(field.type).toBe('password')
    fireEvent.change(field, { target: { value: 'sk_live_x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save to vault' }))

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit.mock.calls[0]![0]).toBe('sk_live_x')
    expect(field.value).toBe('')
  })

  it('will not send an empty value', () => {
    const onSubmit = vi.fn()
    render(<SecretRequestCard request={request()} busy={false} onSubmit={onSubmit} onDismiss={() => {}} />)
    expect(screen.getByRole('button', { name: 'Save to vault' })).toBeDisabled()
  })

  it('offers no field once the secret is in the vault', () => {
    render(<SecretRequestCard request={request({ status: 'provided' })} busy={false} onSubmit={() => {}} onDismiss={() => {}} />)
    expect(screen.getByText('In the vault')).toBeInTheDocument()
    expect(screen.queryByLabelText('Value for STRIPE_API_KEY')).toBeNull()
  })

  it('dismisses', () => {
    const onDismiss = vi.fn()
    render(<SecretRequestCard request={request()} busy={false} onSubmit={() => {}} onDismiss={onDismiss} />)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(onDismiss).toHaveBeenCalled()
  })
})

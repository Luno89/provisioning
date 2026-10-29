import { afterEach, describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useShellStore } from '../stores/shell'
import { useCan } from './useCan'

describe('useCan', () => {
  afterEach(() => useShellStore.getState().setUser(null))

  it('answers from the signed-in session, and nothing for nobody', () => {
    useShellStore.getState().setUser({ id: 'u', email: 'u@example.com', permissions: { administer: true, 'manage-accounts': false } })
    const { result, rerender } = renderHook(() => useCan())
    expect(result.current('administer')).toBe(true)
    expect(result.current('manage-accounts')).toBe(false)
    useShellStore.getState().setUser(null)
    rerender()
    expect(result.current('administer')).toBe(false)
  })

  it('answers a record\'s action from what the record lists', () => {
    const { result } = renderHook(() => useCan())
    expect(result.current('invite', { can: ['invite'] })).toBe(true)
    expect(result.current('change-settings', { can: ['invite'] })).toBe(false)
    expect(result.current('invite', undefined)).toBe(false)
  })
})

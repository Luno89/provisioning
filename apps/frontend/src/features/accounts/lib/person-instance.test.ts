import { describe, expect, it } from 'vitest'
import { instanceLine } from './person-instance'

describe('a person\'s instance in People', () => {
  it('says when root cannot reach it', () => {
    const base = { name: 'bob', where: 'own' as const, status: 'ready' as const, url: 'https://bob.koala.dev', autoUpdates: true }
    expect(instanceLine(base)).toBe('bob on their own machine: running, updates automatically')
    expect(instanceLine({ ...base, unreachableSince: '2026-10-29T10:00:00.000Z' })).toMatch(/^bob on their own machine: running, not answering since .*2026, updates automatically$/)
  })
})

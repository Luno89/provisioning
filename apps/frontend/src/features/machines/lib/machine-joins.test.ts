import { describe, it, expect } from 'vitest'
import { joinStatus } from './machine-joins'

const now = new Date('2026-11-18T10:30:00.000Z')
const join = { id: 'j1', stage: 'k3s', title: 'Installing k3s', at: '2026-11-18T10:00:00.000Z', expiresAt: '2026-11-18T11:00:00.000Z' }

describe('how My Machines reads a join', () => {
  it('is joining while it reports and its command still works', () => {
    expect(joinStatus({ ...join, state: 'started' }, now)).toBe('joining')
    expect(joinStatus({ ...join, state: 'done' }, now)).toBe('joining')
    expect(joinStatus({ ...join, state: 'already-done' }, now)).toBe('joining')
  })

  it('has failed when its stage failed, whether or not its command still works', () => {
    expect(joinStatus({ ...join, state: 'failed', why: 'x' }, now)).toBe('failed')
    expect(joinStatus({ ...join, state: 'failed', why: 'x' }, new Date('2026-11-18T12:00:00.000Z'))).toBe('failed')
  })

  it('has stopped reporting once its command expired before it finished', () => {
    expect(joinStatus({ ...join, state: 'started' }, new Date('2026-11-18T11:00:00.000Z'))).toBe('stopped')
  })
})

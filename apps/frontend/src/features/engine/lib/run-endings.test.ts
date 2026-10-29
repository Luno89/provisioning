import { describe, expect, it } from 'vitest'
import { endedLine, endedTone, endingOf, handoverLine } from './run-endings'

const at = '2026-10-29T10:00:00Z'

describe('how a run ended, in words', () => {
  it('says finished, failed with its reason, and stopped by you or by someone', () => {
    expect(endedLine({ how: 'finished', at })).toBe('Finished')
    expect(endedLine({ how: 'failed', reason: 'the model went away', at })).toBe('Failed: the model went away')
    expect(endedLine({ how: 'stopped', by: 'luno@example.com', at }, 'luno@example.com')).toBe('Stopped by you')
    expect(endedLine({ how: 'stopped', by: 'luno@example.com', at }, 'other@example.com')).toBe('Stopped by luno@example.com')
    expect(endedLine({ how: 'stopped', at })).toBe('Stopped')
  })

  it('says a revoked run ended because its access was revoked, and why', () => {
    expect(endedLine({ how: 'revoked', revokedBecause: 'signed-out-everywhere', at })).toBe('Ended because the access it worked with was revoked: they signed out everywhere')
    expect(endedLine({ how: 'revoked', revokedBecause: 'removed-from-shared-project', at })).toBe('Ended because the access it worked with was revoked: they were removed from the shared project')
    expect(endedTone({ how: 'revoked', at })).toBe('warn')
    expect(endedTone({ how: 'failed', at })).toBe('bad')
    expect(endedTone({ how: 'finished', at })).toBe('good')
  })

  it('introduces the handover note as written after revocation, or says why there is none', () => {
    const revoked = { how: 'revoked' as const, revokedBecause: 'signed-out-everywhere' as const, at }
    expect(handoverLine({ ended: revoked, handover: { note: 'x', path: 'handover/run-1.md' } })).toMatch(/^It left a handover note, also in handover\/run-1\.md\. Written after its access was revoked/)
    expect(handoverLine({ ended: revoked, handover: { failed: 'its model did not answer' } })).toBe('It could not leave a handover note: its model did not answer.')
    expect(handoverLine({ ended: revoked })).toBe('It left no handover note.')
    expect(handoverLine({ ended: { how: 'finished', at } })).toBeUndefined()
  })

  it('finds a run\'s ending among several', () => {
    expect(endingOf([{ runId: 'a' }, { runId: 'b', ended: { how: 'finished', at } }], 'b')?.ended?.how).toBe('finished')
    expect(endingOf(undefined, 'b')).toBeUndefined()
  })
})

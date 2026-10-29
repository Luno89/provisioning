import { describe, expect, it } from 'vitest'
import { openSignals, retiresWhat, SIGNAL_TITLES, severityTone } from './poisoning'
import type { SignalView } from '../types/poisoning'

const signal = (over: Partial<SignalView>): SignalView => ({ id: 's', kind: 'canary', severity: 'certain', state: 'open', at: 't', runId: 'r', tool: 'store_file', said: 'x', ...over })

describe('how a finding is shown', () => {
  it('names every kind and tones the serious ones', () => {
    expect(Object.keys(SIGNAL_TITLES).sort()).toEqual(['canary', 'hidden-in-repo', 'memory-from-outside', 'private-out', 'unvouched-host'])
    expect(severityTone('certain')).toBe('bad')
    expect(severityTone('high')).toBe('bad')
    expect(severityTone('medium')).toBe('warn')
    expect(severityTone('low')).toBe('quiet')
  })

  it('offers retiring only where a run could have left something to retire', () => {
    expect(retiresWhat(signal({ kind: 'memory-from-outside' }))).toBe(true)
    expect(retiresWhat(signal({ kind: 'hidden-in-repo' }))).toBe(false)
  })

  it('keeps the open ones', () => {
    expect(openSignals([signal({ id: 'a' }), signal({ id: 'b', state: 'dismissed' })]).map((one) => one.id)).toEqual(['a'])
  })
})

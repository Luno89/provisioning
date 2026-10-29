import type { SignalKind, SignalSeverity, SignalView } from '../types/poisoning'

export const SIGNAL_TITLES: Readonly<Record<SignalKind, string>> = {
  canary: 'A run copied its own canary out',
  'private-out': 'Private text left in a call',
  'memory-from-outside': 'A memory quotes outside text',
  'unvouched-host': 'A call went to a host only outside text named',
  'hidden-in-repo': 'Hidden characters in repository text',
}

export const SEVERITY_WORDS: Readonly<Record<SignalSeverity, string>> = {
  certain: 'Certain',
  high: 'Serious',
  medium: 'Worth a look',
  low: 'Low',
}

export const severityTone = (severity: SignalSeverity): 'bad' | 'warn' | 'quiet' =>
  severity === 'certain' || severity === 'high' ? 'bad' : severity === 'medium' ? 'warn' : 'quiet'

export const retiresWhat = (signal: Pick<SignalView, 'kind'>): boolean =>
  signal.kind === 'memory-from-outside' || signal.kind === 'canary' || signal.kind === 'private-out' || signal.kind === 'unvouched-host'

export const openSignals = (signals: readonly SignalView[]): SignalView[] => signals.filter((signal) => signal.state === 'open')

export type SignalKind = 'private-out' | 'unvouched-host' | 'canary' | 'memory-from-outside' | 'hidden-in-repo';
export type SignalSeverity = 'certain' | 'high' | 'medium' | 'low';
export type SignalState = 'open' | 'dismissed' | 'resolved';

export const SIGNAL_KINDS: readonly SignalKind[] = ['canary', 'private-out', 'memory-from-outside', 'unvouched-host', 'hidden-in-repo'];

export const KIND_TITLES: Readonly<Record<SignalKind, string>> = {
  canary: 'A run copied its own canary out',
  'private-out': 'Private text left in a call',
  'memory-from-outside': 'A memory quotes outside text',
  'unvouched-host': 'A call went to a host only outside text named',
  'hidden-in-repo': 'Hidden characters in repository text',
};

import { describe, it, expect } from 'vitest';
import { releaseNotice, toastOf } from './toast';

describe('toastOf', () => {
  it('shows a message as itself, an error as an error', () => {
    expect(toastOf({ type: 'info', message: 'A new version (abc) is ready to preview' })).toEqual({ kind: 'info', label: 'Notice', text: 'A new version (abc) is ready to preview' });
    expect(toastOf({ type: 'error', message: 'A release of abc failed: boom' })).toEqual({ kind: 'error', label: 'Error', text: 'A release of abc failed: boom' });
  });

  it('says a resource was destroyed, or deleted outside the platform', () => {
    expect(toastOf({ id: 'c1', name: 'dev' } as never)).toEqual({ kind: 'destroyed', label: 'System Event', text: 'dev Destroyed' });
    expect(toastOf({ name: 'dev', outOfBand: true })).toEqual({ kind: 'external', label: 'External Event', text: 'dev Deleted Externally' });
  });
});

describe('releaseNotice', () => {
  it('tells once that a release waits in preview or failed, however often it is updated', () => {
    const seen = new Set<string>();
    const preview = { id: 'r1', state: 'preview', commit: '13465f2612' };
    expect(releaseNotice(seen, preview)).toEqual({ type: 'info', message: 'A new version (13465f26) is ready to preview — open the project\'s Builds panel to look at it and cut over.' });
    expect(releaseNotice(seen, preview)).toBeUndefined();
    expect(releaseNotice(seen, { ...preview, state: 'failed', reason: 'upgrade failed' })).toEqual({ type: 'error', message: 'A release of 13465f26 failed: upgrade failed' });
    expect(releaseNotice(seen, { ...preview, state: 'failed', reason: 'upgrade failed' })).toBeUndefined();
    expect(releaseNotice(seen, { id: 'r2', state: 'preview', commit: 'abc' })).toBeDefined();
  });

  it('says nothing of other states', () => {
    expect(releaseNotice(new Set(), { id: 'r1', state: 'live', commit: 'abc' })).toBeUndefined();
    expect(releaseNotice(new Set(), { id: 'r1', state: 'preparing', commit: 'abc' })).toBeUndefined();
  });
});

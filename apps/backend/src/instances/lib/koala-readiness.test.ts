import { describe, expect, it } from 'vitest';
import { koalaReadinessOf } from './koala-readiness.js';

describe('whether root has a person\'s Koala ready, from root\'s answer to /api/instances/mine', () => {
  it('is ready only when root records it ready', () => {
    expect(koalaReadinessOf({ instance: { status: 'ready', detail: 'serving' } })).toEqual({ state: 'ready', line: 'ready: serving' });
  });

  it('is failed with root\'s reason when root records it failed', () => {
    expect(koalaReadinessOf({ instance: { status: 'failed', detail: 'the chart\'s backend pod cannot pull its image' } }))
      .toEqual({ state: 'failed', line: 'failed: the chart\'s backend pod cannot pull its image', detail: 'the chart\'s backend pod cannot pull its image' });
    expect(koalaReadinessOf({ instance: { status: 'failed' } })).toEqual({ state: 'failed', line: 'failed: root gave no reason', detail: 'root gave no reason' });
  });

  it('names where to ask for it to be set up again only when its setup stopped and root lets the person ask', () => {
    const stopped = { id: 'inst-1', status: 'failed', detail: 'Koala on desk stopped setting itself up at Gitea: no room', setupAgain: 'stopped' };
    expect(koalaReadinessOf({ instance: stopped, can: ['set-up-again'] })).toEqual({ state: 'failed', line: 'failed: Koala on desk stopped setting itself up at Gitea: no room', detail: 'Koala on desk stopped setting itself up at Gitea: no room', again: '/api/instances/inst-1/setup-again' });
    expect(koalaReadinessOf({ instance: stopped, can: [] })).not.toHaveProperty('again');
    expect(koalaReadinessOf({ instance: { ...stopped, setupAgain: undefined }, can: ['set-up-again'] })).not.toHaveProperty('again');
  });

  it('is not yet ready while root records it joining or installing, or has no Koala for the person yet', () => {
    expect(koalaReadinessOf({ instance: { status: 'installing', detail: 'the instance chart is rolling out' } })).toEqual({ state: 'not yet', line: 'installing: the instance chart is rolling out' });
    expect(koalaReadinessOf({ instance: { status: 'joined' } })).toEqual({ state: 'not yet', line: 'joined: root gave no detail' });
    expect(koalaReadinessOf({ instance: null })).toEqual({ state: 'not yet', line: 'waiting: waiting for this computer to put Koala on itself' });
  });

  it('refuses an answer that is not root\'s shape, naming what came', () => {
    expect(() => koalaReadinessOf({ error: 'Unauthorized' })).toThrow('root\'s answer about your Koala is not one it gives: {"error":"Unauthorized"}');
    expect(() => koalaReadinessOf('nope')).toThrow('root\'s answer about your Koala is not one it gives: "nope"');
  });
});

import { describe, expect, it } from 'vitest';
import type { RunLife } from '../lib/run-watch.js';
import { MachineRunWatch } from './MachineRunWatch.js';

function runs() {
  const closing = new Map<string, (life: RunLife) => void>();
  const lives = new Map<string, RunLife>();
  return {
    closing,
    lives,
    liveness: {
      life: async (runId: string) => {
        const life = lives.get(runId);
        if (!life) throw new Error('Temporal is not answering');
        return life;
      },
      closed: (runId: string) => new Promise<RunLife>((resolve) => closing.set(runId, resolve)),
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('following the runs that hold a machine\'s sessions', () => {
  it('tells the machine when each run ends, once, and forgets runs it no longer names', async () => {
    const { liveness, lives, closing } = runs();
    lives.set('a', 'running').set('b', 'running').set('c', 'ended');
    const told: string[] = [];
    const watch = new MachineRunWatch(liveness, () => {});
    const tell = (runId: string) => told.push(runId);
    watch.follow('desk', 'owner', { runIds: ['a', 'b', 'c'] }, tell);
    await settle();
    expect(told).toEqual(['c']);
    expect(watch.watching('desk')).toEqual(['a', 'b']);
    watch.follow('desk', 'owner', { runIds: ['a', 'b'] }, tell);
    closing.get('a')!('ended');
    await settle();
    expect(told).toEqual(['c', 'a']);
    watch.follow('desk', 'owner', { runIds: [] }, tell);
    closing.get('b')!('ended');
    await settle();
    expect(told).toEqual(['c', 'a']);
  });

  it('keeps following a run while Temporal does not answer, rather than dropping it', async () => {
    const { liveness, closing } = runs();
    const told: string[] = [];
    const watch = new MachineRunWatch(liveness, () => {});
    watch.follow('desk', 'owner', { runIds: ['a'] }, (runId) => told.push(runId));
    await settle();
    expect(watch.watching('desk')).toEqual(['a']);
    closing.get('a')!('ended');
    await settle();
    expect(told).toEqual(['a']);
  });

  it('tells a machine that connected again on its new connection, and nothing once it is gone', async () => {
    const { liveness, lives, closing } = runs();
    lives.set('a', 'running');
    const first: string[] = [];
    const second: string[] = [];
    const watch = new MachineRunWatch(liveness, () => {});
    const tellFirst = (runId: string) => first.push(runId);
    const tellSecond = (runId: string) => second.push(runId);
    watch.follow('desk', 'owner', { runIds: ['a'] }, tellFirst);
    await settle();
    watch.forget('desk', tellFirst);
    watch.follow('desk', 'owner', { runIds: ['a'] }, tellSecond);
    await settle();
    closing.get('a')!('ended');
    await settle();
    expect(first).toEqual([]);
    expect(second).toEqual(['a']);
    watch.forget('desk', tellSecond);
    expect(watch.watching('desk')).toEqual([]);
  });
});

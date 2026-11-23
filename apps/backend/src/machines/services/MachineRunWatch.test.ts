import { describe, expect, it } from 'vitest';
import { reopening } from '@koala/engine-core/reopening';
import type { RunLife } from '../lib/run-watch.js';
import { MachineRunWatch } from './MachineRunWatch.js';

const unavailable = () => Object.assign(new Error('14 UNAVAILABLE: No connection established'), { code: 14 });
const invalid = () => Object.assign(new Error('3 INVALID_ARGUMENT: the run id is not one Temporal takes'), { code: 3 });

function runs() {
  const closing = new Map<string, (life: RunLife) => void>();
  const lives = new Map<string, RunLife>();
  const refused = new Set<string>();
  return {
    closing,
    lives,
    refused,
    liveness: {
      life: async (runId: string) => {
        if (refused.has(runId)) throw invalid();
        const life = lives.get(runId);
        if (!life) throw unavailable();
        return life;
      },
      closed: (runId: string) => new Promise<RunLife>((resolve) => closing.set(runId, resolve)),
    },
  };
}

const soon = () => reopening(0);

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function followingA(world: ReturnType<typeof runs>) {
  const told: string[] = [];
  const watch = new MachineRunWatch(world.liveness, () => {}, soon);
  watch.follow('desk', 'owner', { runIds: ['a'] }, (runId) => told.push(runId));
  await settle();
  await settle();
  return { ...world, told, watch };
}

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

  it('keeps following a run while Temporal does not answer, reads it again once it does, and tells when it ends', async () => {
    const { lives, closing, told, watch } = await followingA(runs());
    expect(watch.watching('desk')).toEqual(['a']);
    expect(closing.has('a')).toBe(false);
    lives.set('a', 'running');
    await settle();
    await settle();
    closing.get('a')!('ended');
    await settle();
    expect(told).toEqual(['a']);
  });

  it('stops following a run whose state Temporal refuses for good, and tells nothing of it', async () => {
    const refusing = runs();
    refusing.refused.add('a');
    const { closing, told, watch } = await followingA(refusing);
    expect(watch.watching('desk')).toEqual([]);
    expect(closing.has('a')).toBe(false);
    expect(told).toEqual([]);
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

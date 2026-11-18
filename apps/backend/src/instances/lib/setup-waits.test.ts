import { describe, expect, it } from 'vitest';
import { setupWaits } from './setup-waits.js';

const noPause = { pause: async () => undefined };
const job = (status: Record<string, unknown>) => ({ kind: 'Job', status });

function world(jobs: Record<string, unknown[]>, mongoDownFor = 0) {
  const asked: string[] = [];
  let mongoAsked = 0;
  return {
    asked,
    deps: {
      job: async (name: string) => {
        asked.push(name);
        const states = jobs[name];
        if (!states || states.length === 0) throw new Error(`Error from server (NotFound): jobs.batch "${name}" not found`);
        return states.length > 1 ? states.shift() : states[0];
      },
      mongo: async () => {
        mongoAsked += 1;
        if (mongoAsked <= mongoDownFor) throw new Error('connect ECONNREFUSED 10.43.0.9:27017');
      },
      wait: noPause,
    },
    mongoAsked: () => mongoAsked,
  };
}

describe('what a setup step waits for before it runs', () => {
  it('waits for the instance\'s Mongo to answer, then for each step before it to finish, in order', async () => {
    const seen = world({
      'luno-move-data-3': [job({ active: 1 }), job({ succeeded: 1 })],
      'luno-platform-services-3': [job({ active: 1 }), job({ active: 1 }), job({ succeeded: 1 })],
    }, 2);
    await setupWaits('move-restore', ['luno-move-data-3', 'luno-platform-services-3'], seen.deps);
    expect(seen.mongoAsked()).toBe(3);
    expect(seen.asked).toEqual(['luno-move-data-3', 'luno-move-data-3', 'luno-platform-services-3', 'luno-platform-services-3', 'luno-platform-services-3']);
  });

  it('waits through a step before it that helm has not made yet', async () => {
    const jobs: Record<string, unknown[]> = { 'luno-platform-services-3': [] };
    const seen = world(jobs);
    let asked = 0;
    const deps = { ...seen.deps, job: async (name: string) => { asked += 1; if (asked === 3) jobs[name] = [job({ succeeded: 1 })]; return seen.deps.job(name); } };
    await setupWaits('seed', ['luno-platform-services-3'], deps);
    expect(asked).toBe(3);
  });

  it('runs at once when it is the first step', async () => {
    const seen = world({});
    await setupWaits('platform-services', [], seen.deps);
    expect(seen.asked).toEqual([]);
    expect(seen.mongoAsked()).toBe(1);
  });

  it('stops, saying which step before it failed and why, since it can never run after it', async () => {
    const seen = world({ 'luno-platform-services-3': [job({ failed: 1, conditions: [{ type: 'Failed', status: 'True', message: 'Job has reached the specified backoff limit' }] })] });
    await expect(setupWaits('seed', ['luno-platform-services-3'], seen.deps))
      .rejects.toThrow('luno-platform-services-3 to finish before seed: luno-platform-services-3 failed, so seed cannot run after it: Job has reached the specified backoff limit');
  });
});

import { describe, expect, it } from 'vitest';
import { DependencyDownError } from '../platform/index.js';
import { tellingWhenDown, type DeletionTold } from './DeleteProjectActivities.js';
import type { ServiceDown } from '../projects/index.js';

const since = '2026-11-21T10:05:00.000Z';
const args = { projectId: 'p1' };

const telling = (attempt: number) => {
  const told: (['down', ServiceDown] | ['back', string])[] = [];
  const to: DeletionTold = {
    down: async (down) => { told.push(['down', down]); },
    back: async (step) => { told.push(['back', step]); },
    attempt: () => attempt,
  };
  return { told, to };
};

describe('a step of a deletion waiting on a service that is down', () => {
  it('tells the deletion which service is down, since when and why, and still fails so Temporal tries the step again', async () => {
    const { told, to } = telling(1);
    const down = new DependencyDownError('infisical', since, 'it cannot be reached: ECONNREFUSED');
    const steps = tellingWhenDown({ RemoveProjectSecretsActivity: async (_given: typeof args) => { throw down; } }, to);
    await expect(steps.RemoveProjectSecretsActivity(args)).rejects.toBe(down);
    expect(told).toEqual([['down', { step: 'RemoveProjectSecretsActivity', dependency: 'infisical', name: 'Infisical', since, reason: 'it cannot be reached: ECONNREFUSED' }]]);
  });

  it('tells the deletion the step carried on once a later try of it succeeds', async () => {
    const { told, to } = telling(3);
    const steps = tellingWhenDown({ RemoveProjectSecretsActivity: async (_given: typeof args) => ({ workspace: true, readers: 0 }) }, to);
    expect(await steps.RemoveProjectSecretsActivity(args)).toEqual({ workspace: true, readers: 0 });
    expect(told).toEqual([['back', 'RemoveProjectSecretsActivity']]);
  });

  it('tells nothing for a first try that succeeds, or a failure that is not a service being down', async () => {
    const { told, to } = telling(1);
    const steps = tellingWhenDown({
      RemoveProjectSecretsActivity: async (_given: typeof args) => ({ workspace: false, readers: 0 }),
      RemoveProjectRepositoriesActivity: async (_given: typeof args): Promise<string[]> => { throw new Error('Gitea refused: 403'); },
    }, to);
    await steps.RemoveProjectSecretsActivity(args);
    await expect(steps.RemoveProjectRepositoriesActivity(args)).rejects.toThrow('Gitea refused: 403');
    expect(told).toEqual([]);
  });
});

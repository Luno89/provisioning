import { describe, it, expect } from 'vitest';
import { marked, releaseHowOf, releaseHowProblem } from './release-run.js';
import type { OdooRelease } from './odoo-release.js';

describe('how a project is released', () => {
  it('takes the project\'s own setting first, then its tree type\'s, then what its repository holds', () => {
    expect(releaseHowOf({ release: { agent: 'my-release', app: 'odoo' } }, { release: { agent: 'release', app: 'odoo' } }, true)).toEqual({ agent: 'my-release', app: 'odoo' });
    expect(releaseHowOf({}, { release: { agent: 'release-replace' } }, true)).toEqual({ agent: 'release-replace' });
    expect(releaseHowOf({}, undefined, true)).toEqual({ agent: 'release', app: 'odoo' });
    expect(releaseHowOf({}, {}, false)).toEqual({ agent: 'release-replace' });
  });

  it('says what is wrong with a setting', () => {
    expect(releaseHowProblem(undefined)).toBeNull();
    expect(releaseHowProblem({ agent: 'release', app: 'odoo' })).toBeNull();
    expect(releaseHowProblem({ app: 'odoo' })).toBe('release must name the agent that releases a build');
    expect(releaseHowProblem({ agent: 'release', app: '' })).toBe('release.app names the app adapter (like odoo)');
    expect(releaseHowProblem('slots')).toBe('release must be { agent, app }');
  });
});

describe('marking a release', () => {
  const release = (id: string, extra: Partial<OdooRelease>): OdooRelease => ({ id, ownerId: 'bo', projectId: 'p1', pipelineRunId: id, commit: `${id}-commit`, image: 'i', state: 'preview', host: 'h', startedAt: id, updatedAt: id, ...extra });

  it('brings a restored release back without the reason it was set aside', () => {
    const changes = marked([release('r1', { state: 'superseded', replacedBy: 'r2', reason: 'replaced' }), release('r2', { state: 'live' })], 'r1', { state: 'live', restoredAt: 'later' }, 'now');
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ id: 'r1', state: 'live', restoredAt: 'later' });
    expect(changes[0]).not.toHaveProperty('replacedBy');
    expect(changes[0]).not.toHaveProperty('reason');
  });

  it('marks nothing for a release it does not know', () => {
    expect(marked([], 'nope', { state: 'live' }, 'now')).toEqual([]);
  });
});

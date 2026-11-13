import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { workFor } from '@koala/engine-core/work-for';
import type { Workflows } from '../../platform/index.js';
import { temporalStoredFileCommits } from './StoredFileCommits.js';

const commitsSeeing = (seen: unknown[]) => {
  const workflows = mock<Pick<Workflows, 'start'>>();
  workflows.start.mockImplementation((async () => {
    seen.push(workFor());
    return { result: async () => ({ op: 'commit', plan: { ok: true, stored: [], replaced: [], absorbed: [] } }) };
  }) as never);
  return temporalStoredFileCommits(async () => workflows, 'engine');
};

describe('keeping and removing stored files through Temporal', () => {
  it('keeps and removes a project\'s files as work for that project, so deleting the project fences them, and anyone else\'s for no project', async () => {
    const seen: unknown[] = [];
    const commits = commitsSeeing(seen);
    await commits.commit('u1', [{ id: 'f1', size: 1 }], { replace: false, scope: { kind: 'project', id: 'p1' } });
    await commits.commit('u1', [{ id: 'f2', size: 1 }], { replace: false, scope: { kind: 'person', id: 'u1' } });
    await commits.remove('u1', [], { kind: 'project', id: 'p1' });
    expect(seen).toEqual([{ project: 'p1' }, undefined, { project: 'p1' }]);
  });
});

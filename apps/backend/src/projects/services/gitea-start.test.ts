import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { reopening } from '@koala/engine-core/reopening';
import type { GiteaService } from './GiteaService.js';
import { keepUsersPrivate } from './gitea-start.js';

describe('the pass that makes Gitea\'s users private at start', () => {
  it('users left public at start are made private once Gitea answers', async () => {
    const gitea = mock<GiteaService>();
    gitea.makeUsersPrivate.mockRejectedValueOnce(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })).mockResolvedValue(['koala-u1']);
    const said: string[] = [];

    expect(await keepUsersPrivate(gitea, { again: () => reopening(5), log: (message) => said.push(message) })).toBe(false);

    await vi.waitFor(() => expect(gitea.makeUsersPrivate).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(said.at(-1)).toBe('[gitea] made 1 user(s) private: koala-u1'));
    expect(said[0]).toMatch(/^\[gitea\] not every Gitea user is private yet: connect ECONNREFUSED; trying again in/);
  });
});

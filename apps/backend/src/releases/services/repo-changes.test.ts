import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { changesIn, type FileHashes } from './repo-changes.js';

describe('what changed in a project\'s repository between two commits', () => {
  it('compares each file\'s hash at the two commits, and refuses a project with no repository', async () => {
    const gitea = mock<FileHashes>();
    gitea.fileHashes.calledWith('acme', 'shop', 'one').mockResolvedValue(new Map([['addons/a.py', '1'], ['e2e/a.spec.ts', '2']]));
    gitea.fileHashes.calledWith('acme', 'shop', 'two').mockResolvedValue(new Map([['addons/a.py', '1'], ['e2e/a.spec.ts', '3'], ['e2e/b.spec.ts', '4']]));
    const changed = changesIn(gitea);
    expect(await changed({ giteaOwner: 'acme', giteaRepo: 'shop' }, 'one', 'two')).toEqual(['e2e/a.spec.ts', 'e2e/b.spec.ts']);
    await expect(changed({}, 'one', 'two')).rejects.toThrow('the project has no repository');
  });
});

import { describe, expect, it } from 'vitest';
import { recordingProcesses } from '@koala/engine-core/testing/processes';
import { withSeedBundle } from './seed-bundle.js';

describe('the files a check starts with', () => {
  it('are committed as the checks identity and bundled, and the bundle is handed on', async () => {
    const git = recordingProcesses(() => ({}));
    const handed = await withSeedBundle({ 'README.md': 'hi\n' }, async (bundle) => bundle, git);
    expect(handed).toMatch(/seed\.bundle$/);
    expect(git.ran.map((run) => run.args.filter((arg) => !arg.includes('/')).join(' '))).toEqual(['init -q -b main', '-C add -A', '-C commit -q -m files the check starts with', '-C bundle create --all']);
    expect(git.ran.every((run) => run.command === 'git' && run.env?.['GIT_AUTHOR_NAME'] === 'Koala checks')).toBe(true);
  });

  it('says what git said when it could not commit them', async () => {
    const git = recordingProcesses((run) => (run.args.includes('commit') ? { code: 128, stderr: 'fatal: unable to auto-detect email address\n' } : {}));
    await expect(withSeedBundle({ 'README.md': 'hi\n' }, async () => undefined, git)).rejects.toThrow('unable to auto-detect email address');
  });
});

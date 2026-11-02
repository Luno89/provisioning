import { describe, expect, it } from 'vitest';
import { HUB_REPO_HOOK_PATH, hubRepoHookSecret, hubRepoHookSecrets, hubRepoHookUrl } from './hub-repo-hooks.js';

describe('the webhook a shared project\'s repository on the hub sends its pushes to', () => {
  it('is signed with a secret of each project\'s own, made from the data key, so nothing new is kept', () => {
    expect(hubRepoHookSecret('key', 'p1')).toMatch(/^[0-9a-f]{64}$/);
    expect(hubRepoHookSecret('key', 'p1')).toBe(hubRepoHookSecret('key', 'p1'));
    expect(hubRepoHookSecret('key', 'p1')).not.toBe(hubRepoHookSecret('key', 'p2'));
    expect(hubRepoHookSecret('key', 'p1')).not.toBe(hubRepoHookSecret('other', 'p1'));
  });

  it('is still taken after the data key is rotated, by the secret its previous key made', () => {
    expect(hubRepoHookSecrets({ current: 'new', previous: ['old'] }, 'p1')).toEqual([hubRepoHookSecret('new', 'p1'), hubRepoHookSecret('old', 'p1')]);
    expect(hubRepoHookSecrets('only', 'p1')).toEqual([hubRepoHookSecret('only', 'p1')]);
  });

  it('is addressed to the backend that serves the hub, by the project', () => {
    expect(hubRepoHookUrl('http://10.0.0.2:3001/', 'a b')).toBe(`http://10.0.0.2:3001${HUB_REPO_HOOK_PATH}/a%20b`);
  });
});

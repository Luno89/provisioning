import { describe, expect, it } from 'vitest';
import { privatePatches } from './gitea-visibility.js';

describe('making every Gitea user private', () => {
  it('patches only the users that are not private yet', () => {
    expect(privatePatches([
      { login: 'alice', login_name: '', source_id: 0, visibility: 'public' },
      { login: 'bob', visibility: 'private' },
      { login: 'carol', login_name: 'carol-ldap', source_id: 3, visibility: 'limited' },
    ])).toEqual([
      { username: 'alice', body: { login_name: 'alice', source_id: 0, visibility: 'private' } },
      { username: 'carol', body: { login_name: 'carol-ldap', source_id: 3, visibility: 'private' } },
    ]);
  });

  it('patches a user whose visibility the listing leaves out, and has nothing to do once all are private', () => {
    expect(privatePatches([{ login: 'dave' }]).map((patch) => patch.username)).toEqual(['dave']);
    expect(privatePatches([{ login: 'bob', visibility: 'private' }])).toEqual([]);
  });
});

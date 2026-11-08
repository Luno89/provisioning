import { describe, expect, it } from 'vitest';
import { giteaSettingsFrom } from './gitea-settings.js';

const GIVEN = { GITEA_URL: 'http://gitea-http.gitea.svc.cluster.local:3000', GITEA_REACHES_KOALA_AT: 'http://luno.nowrinkles.svc.cluster.local' };

describe('the settings a process reaches Gitea with', () => {
  it('reads where Gitea is and where Gitea sends pushes, as the chart gives them', () => {
    expect(giteaSettingsFrom(GIVEN)).toEqual({ url: 'http://gitea-http.gitea.svc.cluster.local:3000', reachesKoalaAt: 'http://luno.nowrinkles.svc.cluster.local' });
  });

  it('reads the hub\'s on dev: the instance\'s Gitea on this computer, and the hub on the pod network', () => {
    expect(giteaSettingsFrom({ GITEA_URL: 'http://127.0.0.1:31737', GITEA_REACHES_KOALA_AT: 'http://10.42.0.1:3003/' })).toEqual({ url: 'http://127.0.0.1:31737', reachesKoalaAt: 'http://10.42.0.1:3003' });
  });

  it.each([
    [{}, 'GITEA_URL, GITEA_REACHES_KOALA_AT are not set'],
    [{ GITEA_URL: GIVEN.GITEA_URL }, 'GITEA_REACHES_KOALA_AT is not set'],
    [{ GITEA_REACHES_KOALA_AT: GIVEN.GITEA_REACHES_KOALA_AT }, 'GITEA_URL is not set'],
    [{ ...GIVEN, GITEA_URL: '' }, 'GITEA_URL is not set'],
    [{ ...GIVEN, GITEA_REACHES_KOALA_AT: '   ' }, 'GITEA_REACHES_KOALA_AT is not set'],
  ])('stops the process naming every setting missing: %j', (env, said) => {
    expect(() => giteaSettingsFrom(env)).toThrow(`Gitea, where projects' repositories are kept, is not set up: ${said}`);
  });

  it('refuses an address that is not one, naming the setting', () => {
    expect(() => giteaSettingsFrom({ ...GIVEN, GITEA_URL: 'gitea-http:3000' })).toThrow('GITEA_URL is not an http or https address: gitea-http:3000');
    expect(() => giteaSettingsFrom({ ...GIVEN, GITEA_REACHES_KOALA_AT: 'http://koala/webhooks' })).toThrow('GITEA_REACHES_KOALA_AT has a path');
  });
});

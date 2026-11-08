import { missingSettings, notSetProblem, settingUrl, type Settings } from '../../platform/lib/setting-urls.js';

export interface GiteaSettings {
  url: string;
  reachesKoalaAt: string;
}

export const GITEA_SETTINGS = ['GITEA_URL', 'GITEA_REACHES_KOALA_AT'] as const;

export function giteaSettingsFrom(env: Settings): GiteaSettings {
  const missing = missingSettings(env, GITEA_SETTINGS);
  if (missing.length) throw new Error(notSetProblem('Gitea, where projects\' repositories are kept, is not set up', missing, 'GITEA_URL is the address this process reaches Gitea at and GITEA_REACHES_KOALA_AT the address Gitea sends pushes to this process at; the instance chart sets both'));
  return { url: settingUrl('GITEA_URL', env.GITEA_URL!), reachesKoalaAt: settingUrl('GITEA_REACHES_KOALA_AT', env.GITEA_REACHES_KOALA_AT!) };
}

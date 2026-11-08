import { missingSettings, notSetProblem, settingUrl, type Settings } from '../../platform/lib/setting-urls.js';

export interface InfisicalSettings {
  url: string;
  production: boolean;
}

export const INFISICAL_SETTINGS = ['INFISICAL_URL'] as const;

export function infisicalSettingsFrom(env: Settings): InfisicalSettings {
  const missing = missingSettings(env, INFISICAL_SETTINGS);
  if (missing.length) throw new Error(notSetProblem('Infisical, where projects\' secrets are kept, is not set up', missing, 'it is the address this process and the apps on Koala\'s own cluster reach Infisical at; the instance chart sets it'));
  return { url: settingUrl('INFISICAL_URL', env.INFISICAL_URL!), production: env.NODE_ENV === 'production' };
}

import { missingSettings, notSetProblem, settingHostPort, type Settings } from '../../platform/lib/setting-urls.js';
import type { RegistryHosts } from './registry-hosts.js';

export const REGISTRY_SETTINGS = ['KOALA_REGISTRY', 'KOALA_REGISTRY_PUSH'] as const;

export function registrySettingsFrom(env: Settings): RegistryHosts {
  const missing = missingSettings(env, REGISTRY_SETTINGS);
  if (missing.length) throw new Error(notSetProblem('The registry workspace images are kept in is not set up', missing, 'KOALA_REGISTRY is where a cluster pulls them from and KOALA_REGISTRY_PUSH where this process pushes them to; the instance chart sets both'));
  return { pull: settingHostPort('KOALA_REGISTRY', env.KOALA_REGISTRY!), push: settingHostPort('KOALA_REGISTRY_PUSH', env.KOALA_REGISTRY_PUSH!) };
}

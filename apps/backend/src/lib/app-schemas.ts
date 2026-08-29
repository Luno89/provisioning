import type { AppSettingsSchema } from './app-settings-schema.js';
import { resolveAppSettings } from './app-settings-schema.js';
import { PALWORLD_SCHEMA } from './palworld-settings.js';
import type { DeploymentMetadata } from './types.js';

export const APP_SETTINGS_SCHEMAS: Record<string, AppSettingsSchema> = {
  palworld: PALWORLD_SCHEMA,
};

export function getAppSettingsSchema(appType?: string): AppSettingsSchema | undefined {
  return appType ? APP_SETTINGS_SCHEMAS[appType] : undefined;
}

export const NO_WEB_UI_APP_TYPES = new Set<string>(['palworld']);

export function resolveAppSettingsDefaults(dep: DeploymentMetadata): DeploymentMetadata {
  const schema = getAppSettingsSchema(dep.appType);
  if (!schema) return dep;
  return Object.assign({}, dep, {
    appSettings: resolveAppSettings(schema, dep.appSettings),
  });
}

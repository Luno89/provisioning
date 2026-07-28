/**
 * Registry of app types whose configuration is schema-driven (see app-settings-schema.ts).
 *
 * Its own module rather than living in index.ts because both the HTTP layer (validating a config
 * PATCH, serving GET /api/app-schemas/:appType) and TemporalBridge (resolving defaults before a
 * deploy) need it, and TemporalBridge must not import from index.ts.
 *
 * Adding a game server is one entry here plus its schema file.
 */
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

/**
 * App types with no HTTP surface. AppExposureService is entirely HTTP (Traefik dispatching by Host
 * header, fronted by Caddy on the root node), so exposing one of these would route to nothing.
 * Mirrored by NO_WEB_UI_APP_TYPES in the frontend, which hides the control.
 */
export const NO_WEB_UI_APP_TYPES = new Set<string>(['palworld']);

/**
 * Fills in every schema default the stored record doesn't override, so the deployment record (and
 * therefore the Config tab) always reflects what is actually running rather than leaving 120-odd
 * fields blank while the construct silently substitutes values nobody wrote down.
 *
 * Same role and rationale as resolveVllmDefaults / resolveTabbyDefaults in app-env.ts — called
 * from the same place in TemporalBridge.
 */
export function resolveAppSettingsDefaults(dep: DeploymentMetadata): DeploymentMetadata {
  const schema = getAppSettingsSchema(dep.appType);
  if (!schema) return dep;
  return Object.assign({}, dep, {
    appSettings: resolveAppSettings(schema, dep.appSettings),
  });
}

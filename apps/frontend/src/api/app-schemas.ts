import { api } from './client'

/**
 * The settings schema for an app type.
 *
 * ── WHY THIS IS FETCHED AND NOT A CONSTANT ──
 * Some app types configure themselves from a schema rather than a handful of first-class fields,
 * and the Config tab RENDERS ITSELF from this response — so adding a setting is a one-file backend
 * change with no matching UI edit. A copy of the schema here would be a second answer to what an
 * app can be configured with, and the UI's copy is the one that silently stops matching.
 *
 * Only app types listed in `lib/app-schemas.ts` have one; the route answers 404 for the rest,
 * which is an ANSWER and not a failure — the caller renders the first-class fields instead.
 */

export const appSchemaKeys = {
  schema: (appType: string) => ['app-schema', appType] as const,
}

/**
 * One configurable setting.
 *
 * Promoted verbatim from `GameServerSettings.tsx`, which had the precise version — a union for
 * `type` and the min/max/step/options a control needs to render itself. The first draft here
 * invented a looser shape and called the list `fields`; the compiler rejected every use of it,
 * which is exactly what should happen to a guessed wire type.
 */
export interface AppSetting {
  key: string;
  env: string;
  type: 'bool' | 'int' | 'float' | 'string' | 'enum';
  default: string;
  category: string;
  label: string;
  help?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  secret?: boolean;
  readonly?: boolean;
}

export interface AppSettingsSchema {
  appType: string;
  categories: string[];
  settings: AppSetting[];
}

export const getAppSchema = (appType: string): Promise<AppSettingsSchema> =>
  api.get<AppSettingsSchema>(`/app-schemas/${appType}`).then((r) => r.data)

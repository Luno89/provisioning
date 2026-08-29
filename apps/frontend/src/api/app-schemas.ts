import { api } from './client'

export const appSchemaKeys = {
  schema: (appType: string) => ['app-schema', appType] as const,
}

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

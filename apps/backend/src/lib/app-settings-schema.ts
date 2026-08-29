
export type AppSettingType = 'bool' | 'int' | 'float' | 'string' | 'enum';

export interface AppSetting {
  readonly key: string;
  readonly env: string;
  readonly type: AppSettingType;
  readonly default: string;
  readonly category: string;
  readonly label: string;
  readonly help?: string;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly options?: readonly string[];
  readonly secret?: boolean;
  readonly readonly?: boolean;
}

export interface AppSettingsSchema {
  readonly appType: string;
  readonly categories: readonly string[];
  readonly settings: readonly AppSetting[];
}

export interface ValidationResult {
  values: Record<string, string>;
  errors: string[];
}

export function indexByEnv(schema: AppSettingsSchema): Map<string, AppSetting> {
  return new Map(schema.settings.map((s) => [s.env, s]));
}

export function resolveAppSettings(
  schema: AppSettingsSchema,
  stored?: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of schema.settings) {
    if (s.secret) continue;
    out[s.env] = s.default;
  }
  for (const [env, value] of Object.entries(stored ?? {})) {
    if (out[env] !== undefined) out[env] = value;
  }
  return out;
}

export function validateAppSettings(
  schema: AppSettingsSchema,
  input: Record<string, unknown>,
): ValidationResult {
  const byEnv = indexByEnv(schema);
  const values: Record<string, string> = {};
  const errors: string[] = [];

  for (const [env, raw] of Object.entries(input ?? {})) {
    const setting = byEnv.get(env);
    if (!setting) {
      errors.push(`Unknown setting "${env}"`);
      continue;
    }
    if (setting.readonly || setting.secret) continue;

    const value = typeof raw === 'string' ? raw.trim() : String(raw);

    switch (setting.type) {
      case 'bool': {
        const lowered = value.toLowerCase();
        if (lowered !== 'true' && lowered !== 'false') {
          errors.push(`"${env}" must be true or false (got "${value}")`);
          continue;
        }
        values[env] = lowered;
        break;
      }
      case 'int':
      case 'float': {
        const n = Number(value);
        if (value === '' || Number.isNaN(n)) {
          errors.push(`"${env}" must be a number (got "${value}")`);
          continue;
        }
        if (setting.type === 'int' && !Number.isInteger(n)) {
          errors.push(`"${env}" must be a whole number (got "${value}")`);
          continue;
        }
        if (setting.min !== undefined && n < setting.min) {
          errors.push(`"${env}" must be >= ${setting.min} (got ${n})`);
          continue;
        }
        if (setting.max !== undefined && n > setting.max) {
          errors.push(`"${env}" must be <= ${setting.max} (got ${n})`);
          continue;
        }
        values[env] = setting.type === 'int' ? String(n) : value;
        break;
      }
      case 'enum': {
        if (setting.options && !setting.options.includes(value)) {
          errors.push(`"${env}" must be one of ${setting.options.join(', ')} (got "${value}")`);
          continue;
        }
        values[env] = value;
        break;
      }
      case 'string':
      default:
        values[env] = value;
        break;
    }
  }

  return { values, errors };
}

export function validateSchemaShape(schema: AppSettingsSchema): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();

  for (const s of schema.settings) {
    if (seen.has(s.env)) errors.push(`Duplicate env var "${s.env}"`);
    seen.add(s.env);

    if (!schema.categories.includes(s.category)) {
      errors.push(`"${s.env}" has category "${s.category}" which is not in the category list`);
    }
    if (s.type === 'enum' && (!s.options || s.options.length === 0)) {
      errors.push(`"${s.env}" is an enum with no options`);
    }

    if (!s.secret) {
      const { errors: defaultErrors } = validateAppSettings(schema, { [s.env]: s.default });
      if (s.readonly) {
        if (s.type === 'int' && !Number.isInteger(Number(s.default))) {
          errors.push(`"${s.env}" default "${s.default}" is not an integer`);
        }
      } else if (defaultErrors.length > 0) {
        errors.push(`"${s.env}" default is invalid: ${defaultErrors.join('; ')}`);
      }
    }
  }

  return errors;
}

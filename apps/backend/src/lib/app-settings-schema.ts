/**
 * Schema-driven app settings.
 *
 * Some app types (game servers, notably) expose ~120 individual configuration options. Giving each
 * one a first-class field on DeploymentMetadata is not viable in this codebase: every per-app field
 * has to be hand-added to eight separate enumeration lists (types.ts, AppEnvArgs, buildAppEnv,
 * TemporalBridge's deployApp + syncConfig arg builders, DeployAppArgs, SyncConfigArgs, and
 * index.ts's CONFIGURABLE_FIELDS). At 120 fields that is ~960 edits, and a single missed list
 * silently drops the setting with no error.
 *
 * So instead: ONE `appSettings: Record<string, string>` field threaded through those lists once,
 * plus a runtime schema per app type. The schema replaces compile-time typing with runtime
 * validation — and, because it is also served to the frontend over HTTP
 * (GET /api/app-schemas/:appType), it drives the Config-tab UI from the same single source of
 * truth. Adding a setting becomes a one-file change.
 */

export type AppSettingType = 'bool' | 'int' | 'float' | 'string' | 'enum';

export interface AppSetting {
  /** Native config key in the app's own config file — documentation/help only. */
  readonly key: string;
  /** Container environment variable name. This is the primary key of the settings map. */
  readonly env: string;
  readonly type: AppSettingType;
  /** Always a string: this is literally the value that goes into the pod's env. */
  readonly default: string;
  readonly category: string;
  readonly label: string;
  readonly help?: string;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly options?: readonly string[];
  /**
   * Rendered as a password field, never pre-filled, and stripped from the stored settings map.
   * Secrets live in a Kubernetes Secret instead — see the Palworld deploy activity — so they
   * never reach MongoDB, synthesized Terraform, or Temporal workflow history.
   */
  readonly secret?: boolean;
  /**
   * Shown in the UI but not user-editable, and stripped on write. These are owned by the
   * construct: a user editing e.g. the game port would leave the hostPort, Service and firewall
   * rule all pointing at the old number, silently making the server unreachable.
   */
  readonly readonly?: boolean;
}

export interface AppSettingsSchema {
  readonly appType: string;
  readonly categories: readonly string[];
  readonly settings: readonly AppSetting[];
}

export interface ValidationResult {
  /** Accepted, type-coerced values. Unknown/readonly/secret keys are absent. */
  values: Record<string, string>;
  errors: string[];
}

export function indexByEnv(schema: AppSettingsSchema): Map<string, AppSetting> {
  return new Map(schema.settings.map((s) => [s.env, s]));
}

/**
 * Full set of env vars to hand the construct: schema defaults with the user's stored overrides
 * applied on top. Resolving defaults here rather than in the construct means the stored record
 * and the Config tab always reflect what is actually running.
 */
export function resolveAppSettings(
  schema: AppSettingsSchema,
  stored?: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of schema.settings) {
    if (s.secret) continue; // injected from a Secret, never from this map
    out[s.env] = s.default;
  }
  for (const [env, value] of Object.entries(stored ?? {})) {
    // Only keys the schema knows about — a stale key left over from an older schema version
    // shouldn't keep being injected into the pod forever.
    if (out[env] !== undefined) out[env] = value;
  }
  return out;
}

/**
 * Validates a user-supplied settings patch.
 *
 * This is a security boundary, not a nicety: these values become container environment variables,
 * so without an allowlist any authenticated user could inject arbitrary env (LD_PRELOAD, and so
 * on) into a pod. The route-level allowlist in index.ts gates field *names* on the deployment
 * record; it says nothing about the *keys inside* this map.
 */
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
    // Silently dropped rather than an error: the UI renders both (greyed out / blank password),
    // so a form submitting the whole set shouldn't be rejected because of them.
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
        // Ints are normalised ("007" -> "7"); floats keep the string the caller wrote. Round-
        // tripping a float through Number would rewrite "1.000000" as "1", which the game accepts
        // but which then never string-compares equal to the schema default — so the Config tab
        // would flag every untouched float as modified.
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

/**
 * Self-check used by the schema's own unit test. A malformed schema is far easier to catch here
 * than as a pod that refuses to start.
 */
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

    // Every default must itself survive validation — otherwise the app ships broken out of the box.
    if (!s.secret) {
      const { errors: defaultErrors } = validateAppSettings(schema, { [s.env]: s.default });
      // readonly settings are skipped by validateAppSettings, so check them directly.
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

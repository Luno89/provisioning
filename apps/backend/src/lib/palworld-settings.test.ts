import { describe, it, expect } from 'vitest';
import {
  PALWORLD_SCHEMA,
  PALWORLD_SECRET_ENVS,
  PALWORLD_GAME_PORT,
  PALWORLD_REST_PORT,
} from './palworld-settings.js';
import {
  validateSchemaShape,
  validateAppSettings,
  resolveAppSettings,
} from './app-settings-schema.js';

describe('palworld settings schema', () => {
  it('is internally consistent', () => {
    // Catches duplicate env names, unknown categories, enums with no options, and defaults that
    // would not survive their own validation — all far cheaper to find here than as a pod that
    // refuses to start.
    expect(validateSchemaShape(PALWORLD_SCHEMA)).toEqual([]);
  });

  it('covers a substantial portion of PalWorldSettings.ini', () => {
    // Guards against a botched edit silently truncating the list.
    expect(PALWORLD_SCHEMA.settings.length).toBeGreaterThan(100);
  });

  it('marks the platform-owned ports readonly', () => {
    // A user editing PORT would leave the hostPort, Service and cloud firewall rule all pointing
    // at the old number, silently making the server unreachable.
    for (const env of ['PORT', 'RCON_PORT', 'REST_API_PORT', 'PUID', 'PGID']) {
      const setting = PALWORLD_SCHEMA.settings.find((s) => s.env === env);
      expect(setting, `${env} missing from schema`).toBeDefined();
      expect(setting!.readonly, `${env} should be readonly`).toBe(true);
    }
  });

  it('marks every password as a secret', () => {
    for (const env of PALWORLD_SECRET_ENVS) {
      const setting = PALWORLD_SCHEMA.settings.find((s) => s.env === env);
      expect(setting, `${env} missing from schema`).toBeDefined();
      expect(setting!.secret, `${env} should be secret`).toBe(true);
    }
  });
});

describe('validateAppSettings', () => {
  it('accepts a valid change', () => {
    const { values, errors } = validateAppSettings(PALWORLD_SCHEMA, { EXP_RATE: '2.5' });
    expect(errors).toEqual([]);
    expect(values.EXP_RATE).toBe('2.5');
  });

  it('rejects an unknown key', () => {
    // This is the security boundary: these values become container env vars, so without an
    // allowlist any authenticated user could inject arbitrary env into a pod.
    const { values, errors } = validateAppSettings(PALWORLD_SCHEMA, { LD_PRELOAD: '/tmp/evil.so' });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('LD_PRELOAD');
    expect(values.LD_PRELOAD).toBeUndefined();
  });

  it('rejects a wrong type', () => {
    const { errors } = validateAppSettings(PALWORLD_SCHEMA, { PLAYERS: 'lots' });
    expect(errors[0]).toContain('PLAYERS');
  });

  it('rejects an out-of-range number', () => {
    const { errors } = validateAppSettings(PALWORLD_SCHEMA, { PLAYERS: '9999' });
    expect(errors[0]).toContain('<=');
  });

  it('rejects a non-integer for an int setting', () => {
    const { errors } = validateAppSettings(PALWORLD_SCHEMA, { PLAYERS: '8.5' });
    expect(errors[0]).toContain('whole number');
  });

  it('rejects an invalid enum value', () => {
    const { errors } = validateAppSettings(PALWORLD_SCHEMA, { DIFFICULTY: 'Impossible' });
    expect(errors[0]).toContain('DIFFICULTY');
  });

  it('strips readonly and secret keys without erroring', () => {
    // The UI renders both (greyed out / blank password), so a form submitting the whole set must
    // not be rejected because of them — they just must not be stored.
    const { values, errors } = validateAppSettings(PALWORLD_SCHEMA, {
      PORT: '9999',
      ADMIN_PASSWORD: 'hunter2',
      EXP_RATE: '2.0',
    });
    expect(errors).toEqual([]);
    expect(values.PORT).toBeUndefined();
    expect(values.ADMIN_PASSWORD).toBeUndefined();
    expect(values.EXP_RATE).toBe('2.0');
  });

  it('normalises booleans', () => {
    const { values, errors } = validateAppSettings(PALWORLD_SCHEMA, { IS_PVP: 'TRUE' });
    expect(errors).toEqual([]);
    expect(values.IS_PVP).toBe('true');
  });
});

describe('resolveAppSettings', () => {
  it('fills every non-secret setting with its default', () => {
    const resolved = resolveAppSettings(PALWORLD_SCHEMA);
    expect(resolved.PORT).toBe(String(PALWORLD_GAME_PORT));
    expect(resolved.REST_API_PORT).toBe(String(PALWORLD_REST_PORT));
    expect(resolved.DIFFICULTY).toBe('None');
    // Secrets come from the Kubernetes Secret, never this map.
    for (const env of PALWORLD_SECRET_ENVS) {
      expect(resolved[env]).toBeUndefined();
    }
  });

  it('applies stored overrides on top of defaults', () => {
    const resolved = resolveAppSettings(PALWORLD_SCHEMA, { EXP_RATE: '3.0' });
    expect(resolved.EXP_RATE).toBe('3.0');
    expect(resolved.PAL_CAPTURE_RATE).toBe('1.000000'); // untouched default
  });

  it('drops stored keys the schema no longer knows about', () => {
    // Otherwise a setting removed in a later schema version keeps being injected into the pod.
    const resolved = resolveAppSettings(PALWORLD_SCHEMA, { REMOVED_IN_V2: 'x' });
    expect(resolved.REMOVED_IN_V2).toBeUndefined();
  });
});

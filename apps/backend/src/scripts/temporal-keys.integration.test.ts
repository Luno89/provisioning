import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MissingKeysError } from '../platform/lib/keys.js';
import { temporalJwks } from '../platform/lib/temporal-auth.js';
import { testKeyEnv } from '../platform/testing/keys.js';
import { temporalKeys } from './temporal-keys.js';

const env = testKeyEnv('temporal-keys-entry');

function terminal(): { write: (text: string) => void; shown: () => string } {
  let text = '';
  return { write: (more) => { text += more; }, shown: () => text };
}

describe('the temporal-keys entry, which hands Temporal the public half of the platform\'s Temporal key', () => {
  it('writes the key set where Temporal reads it, readable by Temporal, and says where', async () => {
    const target = join(mkdtempSync(join(tmpdir(), 'koala-temporal-keys-')), 'keys', 'temporal-jwks.json');
    const shown = terminal();
    await temporalKeys(target, env, shown);
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual(temporalJwks(env.TEMPORAL_KEY!));
    expect(statSync(target).mode & 0o777).toBe(0o644);
    expect(shown.shown()).toBe(`[temporal-keys] Temporal reads Koala's public key from ${target}\n`);
  });

  it('prints the key set when given nowhere to write it', async () => {
    const shown = terminal();
    await temporalKeys(undefined, env, shown);
    expect(JSON.parse(shown.shown())).toEqual(temporalJwks(env.TEMPORAL_KEY!));
  });

  it('refuses without the platform\'s Temporal key, naming it', async () => {
    await expect(temporalKeys(undefined, {}, terminal())).rejects.toThrow(MissingKeysError);
    await expect(temporalKeys(undefined, {}, terminal())).rejects.toThrow(/^TEMPORAL_KEY is not set/);
  });
});

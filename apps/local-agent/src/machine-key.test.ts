import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { newClientKey, type KeyReplacement } from '@koala/engine-core/root-client';
import { heldMachineKey, replaceMachineKey, settleMachineKey, type MachineKeyClient } from './machine-key.js';

let dir: string | undefined;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined; });

const OFFER: KeyReplacement = { registrationAccessToken: 'one-use', registrationClientUri: 'https://root.test/oidc/reg/desk' };
const OLD = newClientKey();

async function savedFile(extra: Record<string, unknown> = {}): Promise<string> {
  dir = await mkdtemp(path.join(os.tmpdir(), 'machine-key-'));
  const file = path.join(dir, 'machine.json');
  await writeFile(file, JSON.stringify({ rootUrl: 'https://root.test', deviceId: 'desk', rootDir: dir, key: OLD, ...extra }), { mode: 0o600 });
  return file;
}
const read = async (file: string) => JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;

describe('a machine replacing its key when root offers', () => {
  it('keeps the new key, and only it, once root took it, leaving every other setting and the file readable only by the person', async () => {
    const file = await savedFile({ agentsNotSetUp: 'later' });
    const asked: Array<{ offer: KeyReplacement; key: string; pending: unknown }> = [];
    const client = { replaceKey: async (offer: KeyReplacement, key: string) => { asked.push({ offer, key, pending: (await read(file)).nextKey }); } };
    await replaceMachineKey(client, OFFER, file);
    const saved = await read(file);
    expect(asked).toEqual([{ offer: OFFER, key: saved.key, pending: saved.key }]);
    expect(saved.key).not.toBe(OLD);
    expect(saved).toEqual({ rootUrl: 'https://root.test', deviceId: 'desk', rootDir: dir, key: saved.key, agentsNotSetUp: 'later' });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('keeps its old key when root answered that it did not take the new one, and says why', async () => {
    const file = await savedFile();
    const client = { replaceKey: async () => { throw Object.assign(new Error('root refused'), { answered: true }); } };
    await expect(replaceMachineKey(client, OFFER, file)).rejects.toThrow('root refused');
    expect(await read(file)).toEqual({ rootUrl: 'https://root.test', deviceId: 'desk', rootDir: dir, key: OLD });
  });

  it('holds the new key beside the old when root could not be heard, and settles on whichever root keeps the next time it starts', async () => {
    const file = await savedFile();
    const client = { replaceKey: async () => { throw new Error('fetch failed'); } };
    await expect(replaceMachineKey(client, OFFER, file)).rejects.toThrow('fetch failed');
    const pending = (await read(file)).nextKey as string;
    expect(pending).toBeTruthy();
    expect(await settleMachineKey(file, async (key) => key === pending)).toBe(pending);
    expect(await read(file)).toEqual({ rootUrl: 'https://root.test', deviceId: 'desk', rootDir: dir, key: pending });

    const again = await savedFile({ nextKey: newClientKey() });
    expect(await settleMachineKey(again, async () => false)).toBe(OLD);
    expect(await read(again)).toEqual({ rootUrl: 'https://root.test', deviceId: 'desk', rootDir: dir, key: OLD });
  });

  it('takes a token of its new key the moment root refuses its old one, when root took the new key though its answer never came, and keeps only the new key', async () => {
    const file = await savedFile();
    const rootHolds = new Set([OLD]);
    const refusedKey = Object.assign(new Error('client authentication failed'), { name: 'ResponseBodyError', error: 'invalid_client' });
    const clientOf = (key: string): MachineKeyClient => {
      const token = async (resource?: string): Promise<string> => { if (!rootHolds.has(key)) throw refusedKey; return `token of ${key === OLD ? 'the old key' : 'the new key'}${resource ? ` for ${resource}` : ''}`; };
      return {
        token,
        freshToken: token,
        tokenIfKnown: async () => (rootHolds.has(key) ? token() : undefined),
        replaceKey: async (_offer, next) => {
          rootHolds.clear();
          rootHolds.add(next);
          throw new Error('the connection dropped before root answered');
        },
      };
    };
    const held = await heldMachineKey(file, clientOf);
    expect(await held.token()).toBe('token of the old key');
    await expect(held.replaceKey(OFFER)).rejects.toThrow('the connection dropped before root answered');
    const pending = (await read(file)).nextKey as string;
    expect(rootHolds).toEqual(new Set([pending]));
    expect(await held.freshToken('urn:koala:instance:inst-1')).toBe('token of the new key for urn:koala:instance:inst-1');
    expect(await held.token()).toBe('token of the new key');
    expect(await held.token('urn:koala:instance:inst-1')).toBe('token of the new key for urn:koala:instance:inst-1');
    expect(await read(file)).toEqual({ rootUrl: 'https://root.test', deviceId: 'desk', rootDir: dir, key: pending });
  });

  it('says root refused it when root holds neither key it keeps', async () => {
    const file = await savedFile({ nextKey: newClientKey() });
    const refusedKey = Object.assign(new Error('client authentication failed'), { name: 'ResponseBodyError', error: 'invalid_client' });
    let known = true;
    const clientOf = (key: string): MachineKeyClient => ({
      token: async () => { if (!known) throw refusedKey; return key === OLD ? 'old' : 'next'; },
      freshToken: async () => { if (!known) throw refusedKey; return key === OLD ? 'old' : 'next'; },
      tokenIfKnown: async () => (known && key === OLD ? 'old' : undefined),
      replaceKey: async () => undefined,
    });
    const held = await heldMachineKey(file, clientOf);
    expect(await held.token()).toBe('old');
    known = false;
    await expect(held.freshToken()).rejects.toBe(refusedKey);
    expect(await read(file)).toEqual({ rootUrl: 'https://root.test', deviceId: 'desk', rootDir: dir, key: OLD });
  });

  it('settles on its key without asking root when it holds no new key beside it', async () => {
    const file = await savedFile();
    expect(await settleMachineKey(file, async () => { throw new Error('root was asked'); })).toBe(OLD);
  });
});

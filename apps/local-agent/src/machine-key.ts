import { readFile, rename, writeFile } from 'node:fs/promises';
import { clientRefused, newClientKey, type KeyReplacement, type MetricsClient } from '@koala/engine-core/root-client';
import { metricsClientFile } from './machine-config.js';
import { metricsClientManifest } from './machine-metrics.js';

type Saved = Record<string, unknown> & { key?: unknown; nextKey?: unknown };

const readSaved = async (file: string): Promise<Saved> => JSON.parse(await readFile(file, 'utf8')) as Saved;

async function writeSaved(file: string, saved: Saved): Promise<void> {
  const next = `${file}.next`;
  await writeFile(next, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
  await rename(next, file);
}

const withoutPending = ({ nextKey: _pending, ...rest }: Saved): Saved => rest;

async function writeMetricsClient(file: string, client: MetricsClient): Promise<void> {
  const target = metricsClientFile(file);
  const next = `${target}.next`;
  await writeFile(next, metricsClientManifest(client), { mode: 0o600 });
  await rename(next, target);
}

export async function replaceMachineKey(client: { replaceKey(offer: KeyReplacement, key: string): Promise<MetricsClient> }, offer: KeyReplacement, file: string): Promise<string> {
  const key = newClientKey();
  await writeSaved(file, { ...await readSaved(file), nextKey: key });
  let metrics: MetricsClient;
  try {
    metrics = await client.replaceKey(offer, key);
  } catch (err) {
    if ((err as { answered?: unknown }).answered === true) await writeSaved(file, withoutPending(await readSaved(file)));
    throw err;
  }
  await writeMetricsClient(file, metrics);
  await writeSaved(file, { ...withoutPending(await readSaved(file)), key });
  return key;
}

export interface MachineKeyClient {
  token(resource?: string): Promise<string>;
  freshToken(resource?: string): Promise<string>;
  tokenIfKnown(): Promise<string | undefined>;
  replaceKey(offer: KeyReplacement, key: string): Promise<MetricsClient>;
}

export interface HeldMachineKey {
  token(resource?: string): Promise<string>;
  freshToken(resource?: string): Promise<string>;
  replaceKey(offer: KeyReplacement): Promise<void>;
}

export async function heldMachineKey(file: string, clientOf: (key: string) => MachineKeyClient): Promise<HeldMachineKey> {
  const settled = (): Promise<string> => settleMachineKey(file, async (held) => (await clientOf(held).tokenIfKnown()) !== undefined);
  let key = await settled();
  let client = clientOf(key);
  const taken = async (take: (from: MachineKeyClient) => Promise<string>): Promise<string> => {
    try {
      return await take(client);
    } catch (err) {
      if (!clientRefused(err)) throw err;
      const kept = await settled();
      if (kept === key) throw err;
      key = kept;
      client = clientOf(kept);
      return take(client);
    }
  };
  return {
    token: (resource) => taken((from) => from.token(resource)),
    freshToken: (resource) => taken((from) => from.freshToken(resource)),
    replaceKey: async (offer) => { key = await replaceMachineKey(client, offer, file); },
  };
}

export async function settleMachineKey(file: string, rootKeeps: (key: string) => Promise<boolean>): Promise<string> {
  const saved = await readSaved(file);
  const key = typeof saved.key === 'string' ? saved.key : '';
  if (typeof saved.nextKey !== 'string' || !saved.nextKey) return key;
  const settled = await rootKeeps(saved.nextKey) ? saved.nextKey : key;
  await writeSaved(file, { ...withoutPending(saved), key: settled });
  return settled;
}

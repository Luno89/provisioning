import { readFile, rename, writeFile } from 'node:fs/promises';
import { newClientKey, type KeyReplacement } from '@koala/engine-core/root-client';

type Saved = Record<string, unknown> & { key?: unknown; nextKey?: unknown };

const readSaved = async (file: string): Promise<Saved> => JSON.parse(await readFile(file, 'utf8')) as Saved;

async function writeSaved(file: string, saved: Saved): Promise<void> {
  const next = `${file}.next`;
  await writeFile(next, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
  await rename(next, file);
}

const withoutPending = ({ nextKey: _pending, ...rest }: Saved): Saved => rest;

export async function replaceMachineKey(client: { replaceKey(offer: KeyReplacement, key: string): Promise<void> }, offer: KeyReplacement, file: string): Promise<void> {
  const key = newClientKey();
  await writeSaved(file, { ...await readSaved(file), nextKey: key });
  try {
    await client.replaceKey(offer, key);
  } catch (err) {
    if ((err as { answered?: unknown }).answered === true) await writeSaved(file, withoutPending(await readSaved(file)));
    throw err;
  }
  await writeSaved(file, { ...withoutPending(await readSaved(file)), key });
}

export async function settleMachineKey(file: string, rootKeeps: (key: string) => Promise<boolean>): Promise<string> {
  const saved = await readSaved(file);
  const key = typeof saved.key === 'string' ? saved.key : '';
  if (typeof saved.nextKey !== 'string' || !saved.nextKey) return key;
  const settled = await rootKeeps(saved.nextKey) ? saved.nextKey : key;
  await writeSaved(file, { ...withoutPending(saved), key: settled });
  return settled;
}

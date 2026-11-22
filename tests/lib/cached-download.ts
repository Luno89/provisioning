import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';

export type Download = (to: string) => Promise<void>;

const inFlight = new Map<string, Promise<string>>();

async function fetchInto(target: string, download: Download): Promise<string> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  if (fssync.existsSync(target)) return target;
  const partial = `${target}.${process.pid}-${randomBytes(4).toString('hex')}.downloading`;
  try {
    await download(partial);
    await fs.rename(partial, target);
  } finally {
    await fs.rm(partial, { force: true });
  }
  return target;
}

export function cachedDownload(target: string, download: Download): Promise<string> {
  const running = inFlight.get(target);
  if (running) return running;
  const fetched = fetchInto(target, download).finally(() => inFlight.delete(target));
  inFlight.set(target, fetched);
  return fetched;
}

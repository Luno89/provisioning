import { mkdtemp, open, rm, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DropReader, type DropSettings, type DroppedFile } from '../lib/drops.js';

export type ReceivedDrop = { ok: true; settings: DropSettings; files: DroppedFile[] } | { ok: false; why: string };

async function receiveInto(body: AsyncIterable<Buffer | string>, folder: string): Promise<ReceivedDrop> {
  const reader = new DropReader();
  const files: DroppedFile[] = [];
  let settings: DropSettings | undefined;
  let writing: FileHandle | undefined;
  const settle = async (events: ReturnType<DropReader['push']>): Promise<string | undefined> => {
    for (const event of events) {
      if (event.kind === 'refused') return event.why;
      if (event.kind === 'settings') settings = event.settings;
      if (event.kind === 'file') {
        const source = path.join(folder, String(files.length));
        files.push({ path: event.path, source, size: event.size });
        writing = await open(source, 'wx');
      }
      if (event.kind === 'bytes') await writing!.write(event.chunk);
      if (event.kind === 'fileEnd') {
        await writing!.close();
        writing = undefined;
      }
    }
    return undefined;
  };
  let refused: string | undefined;
  try {
    for await (const chunk of body) {
      if (!refused) refused = await settle(reader.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk));
    }
    refused ??= await settle(reader.finish());
    if (refused) return { ok: false, why: refused };
    return { ok: true, settings: settings!, files };
  } finally {
    await writing?.close();
  }
}

export async function withReceivedDrop<T>(body: AsyncIterable<Buffer | string>, work: (drop: ReceivedDrop) => Promise<T>): Promise<T> {
  const folder = await mkdtemp(path.join(tmpdir(), 'koala-drop-'));
  try {
    return await work(await receiveInto(body, folder));
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

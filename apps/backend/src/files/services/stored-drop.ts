import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { ignore } from '@koala/engine-core/failures';
import { contentTypeOf } from '../lib/artifacts.js';
import { DropReader, type DropEvent } from '../lib/drops.js';
import { alreadyThere } from '../lib/file-room.js';
import type { FilesRefusal, StoredFileRecord } from '../lib/stored-files.js';
import type { StoredOutcome, UploadBatch } from './StoredFiles.js';

interface Arriving {
  pass: PassThrough;
  added: Promise<StoredOutcome<StoredFileRecord>>;
}

export async function receiveStoredDrop(
  body: AsyncIterable<Buffer | string>,
  open: (replace: boolean) => Promise<UploadBatch>,
  placed: (path: string) => string,
): Promise<StoredOutcome<StoredFileRecord[]>> {
  const reader = new DropReader();
  const taken: string[] = [];
  let batch: UploadBatch | undefined;
  let refusal: FilesRefusal | undefined;
  let arriving: Arriving | undefined;

  const arrive = async (chunk: Buffer, file: Arriving): Promise<void> => {
    if (file.pass.write(chunk)) return;
    const drained = once(file.pass, 'drain').then(() => undefined);
    const settled = await Promise.race([drained, file.added]);
    if (settled && !settled.ok) refusal = settled;
  };

  const settle = async (events: readonly DropEvent[]): Promise<void> => {
    for (const event of events) {
      if (refusal) return;
      if (event.kind === 'refused') refusal = { ok: false, status: 400, why: event.why };
      if (event.kind === 'settings') batch = await open(event.settings.replace === true);
      if (event.kind === 'file') {
        const at = placed(event.path);
        const checked = batch!.check(at);
        if (!checked.ok) {
          refusal = checked;
          return;
        }
        if (checked.value.taken && !batch!.replace) taken.push(checked.value.path);
        if (taken.length > 0) continue;
        const pass = new PassThrough();
        arriving = { pass, added: batch!.add(at, pass, event.size, event.type ?? contentTypeOf(event.path)) };
      }
      if (event.kind === 'bytes' && arriving) await arrive(event.chunk, arriving);
      if (event.kind === 'fileEnd' && arriving) {
        const file = arriving;
        arriving = undefined;
        file.pass.end();
        const added = await file.added;
        if (!added.ok) refusal = added;
      }
    }
  };

  const stopArriving = async (): Promise<void> => {
    if (!arriving) return;
    const file = arriving;
    arriving = undefined;
    file.pass.destroy();
    await file.added.then(() => undefined, ignore('the file was ended because the drop is refused or failed, and the batch it was in is abandoned or left to the sweep, so its upload failing changes nothing'));
  };

  try {
    for await (const chunk of body) {
      if (!refusal) await settle(reader.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk));
    }
    if (!refusal) await settle(reader.finish());
  } catch (err) {
    await stopArriving();
    throw err;
  }
  if (!refusal && taken.length > 0) refusal = { ok: false, status: 409, why: alreadyThere(taken), exists: taken };
  if (!refusal) return batch!.keep();
  await stopArriving();
  await batch?.abandon();
  return refusal;
}

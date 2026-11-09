import type { ChangeStream, Collection, Document } from 'mongodb';
import { ignore } from '@koala/engine-core/failures';
import { REOPEN_FIRST_MS, reopening } from '@koala/engine-core/reopening';

export interface Watching {
  ready: Promise<void>;
  close(): Promise<void>;
}

export function watchingAll(watchings: Watching[]): Watching {
  return {
    ready: Promise.all(watchings.map((watching) => watching.ready)).then(() => undefined),
    close: async () => { await Promise.all(watchings.map((watching) => watching.close())); },
  };
}


export function watchWrites<T extends Document>(
  collection: () => Collection<T>,
  matching: Document,
  on: (doc: T) => void,
  reopenMs = REOPEN_FIRST_MS,
): Watching {
  let stream: ChangeStream<T> | undefined;
  let closed = false;
  let after: unknown;
  const again = reopening(reopenMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let opened!: () => void;
  const ready = new Promise<void>((done) => { opened = done; });

  const reopen = (err: unknown): void => {
    const failed = stream;
    stream = undefined;
    void failed?.close().catch(ignore('a stream that already failed has nothing left to close'));
    if (closed) return;
    console.warn(`[change-streams] following ${collection().collectionName} stopped (${(err as Error).message}); opening it again in ${again.seconds} s`);
    timer = again.later(open);
  };

  function open(): void {
    if (closed) return;
    try {
      const fullDocument = Object.fromEntries(Object.entries(matching).map(([field, condition]): [string, unknown] => [`fullDocument.${field}`, condition]));
      stream = collection().watch<T>(
        [{ $match: { operationType: { $in: ['insert', 'update', 'replace'] }, ...fullDocument } }],
        { fullDocument: 'updateLookup', ...(after ? { startAfter: after } : {}) },
      );
    } catch (err) {
      reopen(err);
      return;
    }
    stream.on('resumeTokenChanged', (token: unknown) => { after = token; again.reset(); opened(); });
    stream.on('change', (change) => {
      if ('fullDocument' in change && change.fullDocument) on(change.fullDocument as T);
    });
    stream.on('error', reopen);
  }

  open();
  return {
    ready,
    close: async () => {
      closed = true;
      if (timer) clearTimeout(timer);
      await stream?.close();
    },
  };
}

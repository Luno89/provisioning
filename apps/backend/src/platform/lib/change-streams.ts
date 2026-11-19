import type { ChangeStream, ChangeStreamDocument, ChangeStreamOptions, Collection, Document } from 'mongodb';
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


const onWritten = (matching: Document): Document => Object.fromEntries(Object.entries(matching).map(([field, condition]): [string, unknown] => (field === '$or'
  ? [field, (condition as Document[]).map(onWritten)]
  : [`fullDocument.${field}`, condition])));

export function watchWrites<T extends Document>(
  collection: () => Collection<T>,
  matching: Document,
  on: (doc: T) => void,
  reopenMs = REOPEN_FIRST_MS,
): Watching {
  return watchChanges(collection, [{ $match: { operationType: { $in: ['insert', 'update', 'replace'] }, ...onWritten(matching) } }], { fullDocument: 'updateLookup' }, (change) => {
    if ('fullDocument' in change && change.fullDocument) on(change.fullDocument as T);
  }, reopenMs);
}

function watchChanges<T extends Document>(
  collection: () => Collection<T>,
  pipeline: Document[],
  options: ChangeStreamOptions,
  on: (change: ChangeStreamDocument<T>) => void,
  reopenMs: number,
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
      stream = collection().watch<T>(pipeline, { ...options, ...(after ? { startAfter: after } : {}) });
    } catch (err) {
      reopen(err);
      return;
    }
    stream.on('resumeTokenChanged', (token: unknown) => { after = token; again.reset(); opened(); });
    stream.on('change', (change) => on(change));
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

import type { ChangeStream, ChangeStreamDocument, ChangeStreamOptions, Collection, Db, Document } from 'mongodb';
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

const kept = new Set<string>();
const NAMESPACE_EXISTS = 48;
const keptName = (dbName: string, name: string): string => `${dbName}.${name}`;

export async function keepWrittenDocuments(db: Db, names: readonly string[]): Promise<void> {
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((found) => found.name));
  for (const name of names) {
    if (!existing.has(name)) {
      await db.createCollection(name).catch((err: unknown) => {
        if ((err as { code?: number }).code !== NAMESPACE_EXISTS) throw err;
      });
    }
    await db.command({ collMod: name, changeStreamPreAndPostImages: { enabled: true } });
    kept.add(keptName(db.databaseName, name));
  }
}

const WRITES: Document = { operationType: { $in: ['insert', 'update', 'replace'] } };

export function watchWrites<T extends Document>(
  collection: () => Collection<T>,
  matching: Document,
  on: (doc: T) => void,
  reopenMs = REOPEN_FIRST_MS,
): Watching {
  const watched = collection();
  if (!kept.has(keptName(watched.dbName, watched.collectionName))) {
    throw new Error(`${watched.collectionName} is not set up to keep the documents its writes leave, so following them would miss states: its store's setup has to keep them before it is followed`);
  }
  return watchChanges(collection, [{ $match: { ...WRITES, ...onWritten(matching) } }], { fullDocument: 'required' }, (change) => {
    if ('fullDocument' in change && change.fullDocument) on(change.fullDocument as T);
  }, reopenMs);
}

export function watchNudges<T extends Document>(
  collection: () => Collection<T>,
  on: (key: Document) => void,
  reopenMs = REOPEN_FIRST_MS,
): Watching {
  return watchChanges(collection, [{ $match: WRITES }], {}, (change) => {
    if ('documentKey' in change) on(change.documentKey as Document);
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

import { statusFailure, type Failure } from '@koala/engine-core/failures';
import { reopening, type Reopening } from '@koala/engine-core/reopening';
import { joined, type Source } from '@koala/engine-core/until';
import { lineSplitter } from './lines.js';

export interface Watch {
  stop(): void;
  ended: Promise<{ code: number; stderr: string }>;
}

export interface ClusterWatch {
  kubectl(args: readonly string[]): Promise<string>;
  watch(path: string, heard: (chunk: string) => void): Promise<Watch>;
}

export interface Resource {
  kind: string;
  path: string;
  labelSelector?: string;
}

export interface Item {
  kind?: string;
  metadata?: { name?: string; namespace?: string; uid?: string; resourceVersion?: string };
  [field: string]: unknown;
}

export interface Listed {
  items: Item[];
}

interface Status { code?: number; reason?: string; message?: string }
interface Event { type?: string; object?: Item & Status }

type Ending = 'again' | 'relist' | 'reopen' | 'over';

const STATUS_OF: Readonly<Record<string, number>> = {
  BadRequest: 400, Unauthorized: 401, Forbidden: 403, NotFound: 404, MethodNotAllowed: 405, NotAcceptable: 406, Conflict: 409,
  Gone: 410, UnsupportedMediaType: 415, Invalid: 422, TooManyRequests: 429, InternalError: 500, ServiceUnavailable: 503, Timeout: 504,
};
const FROM_SERVER = /Error from server \((\w+)\)/;
const UNANSWERED = /Unable to connect to the server|The connection to the server .* was refused|connection refused|connection reset|unexpected EOF|\bEOF\b|i\/o timeout|TLS handshake timeout|http2: client connection lost|net\/http: /;
const GONE = 410;

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err)).trim();

export function kubectlFailure(said: string): Failure & { status?: number } {
  const named = FROM_SERVER.exec(said)?.[1];
  const status = named === undefined ? undefined : STATUS_OF[named];
  if (status !== undefined) return { kind: statusFailure(status).kind, reason: said, status };
  return { kind: UNANSWERED.test(said) ? 'temporary' : 'final', reason: said };
}

const pathOf = (resource: Resource, query: Record<string, string>): string => {
  const params = new URLSearchParams({ ...(resource.labelSelector ? { labelSelector: resource.labelSelector } : {}), ...query });
  return `${resource.path}?${params.toString()}`;
};

async function listOf(cluster: ClusterWatch, resource: Resource): Promise<{ items: Item[]; version: string }> {
  const list = JSON.parse(await cluster.kubectl(['get', `--raw=${pathOf(resource, {})}`])) as { metadata?: { resourceVersion?: string }; items?: Item[] };
  return { items: (list.items ?? []).map((item) => ({ kind: resource.kind, ...item })), version: list.metadata?.resourceVersion ?? '' };
}

export async function listedOnce(cluster: ClusterWatch, resources: readonly Resource[]): Promise<Listed> {
  return { items: (await Promise.all(resources.map((resource) => listOf(cluster, resource)))).flatMap((list) => list.items) };
}

const keyOf = (item: Item): string => item.metadata?.uid ?? `${item.metadata?.namespace ?? ''}/${item.metadata?.name ?? ''}`;

export function informer(cluster: ClusterWatch, resource: Resource, reopen: Reopening = reopening()): Source<Listed> {
  return (listener) => {
    const items = new Map<string, Item>();
    let version = '';
    let closed = false;
    let watch: Watch | undefined;
    const said = (): void => listener.change({ items: [...items.values()] });
    const broke = (why: string): void => {
      if (closed) return;
      closed = true;
      watch?.stop();
      listener.broke(why);
    };

    const listing = async (): Promise<void> => {
      while (!closed) {
        let list: { items: Item[]; version: string };
        try {
          list = await listOf(cluster, resource);
        } catch (err) {
          const failure = kubectlFailure(messageOf(err));
          if (failure.kind === 'final') return broke(failure.reason);
          await reopen.after();
          continue;
        }
        if (closed) return;
        items.clear();
        for (const item of list.items) items.set(keyOf(item), item);
        version = list.version;
        reopen.reset();
        return said();
      }
    };

    const watching = async (): Promise<Ending> => {
      let ending: Ending | undefined;
      const heard = (line: string): void => {
        if (closed || ending || !line.trim()) return;
        const event = JSON.parse(line) as Event;
        const object = event.object ?? {};
        if (event.type === 'ERROR') {
          const status = object.code ?? 0;
          if (status === GONE) ending = 'relist';
          else if (statusFailure(status).kind === 'final') return broke(object.message ?? object.reason ?? `the watch was refused (${status})`);
          else ending = 'reopen';
          watch?.stop();
          return;
        }
        version = object.metadata?.resourceVersion ?? version;
        if (event.type === 'BOOKMARK') return;
        if (event.type === 'DELETED') items.delete(keyOf(object));
        else items.set(keyOf(object), object);
        said();
      };
      const lines = lineSplitter(heard);
      watch = await cluster.watch(pathOf(resource, { watch: '1', allowWatchBookmarks: 'true', resourceVersion: version }), (chunk) => lines.push(chunk));
      if (closed || ending) watch.stop();
      const end = await watch.ended;
      lines.end();
      if (closed) return 'over';
      if (ending) return ending;
      if (end.code === 0) return 'again';
      const failure = kubectlFailure(end.stderr.trim() || `the watch ended with ${end.code}`);
      if (failure.status === GONE) return 'relist';
      if (failure.kind === 'final') {
        broke(failure.reason);
        return 'over';
      }
      return 'reopen';
    };

    const run = async (): Promise<void> => {
      await listing();
      while (!closed) {
        const ending = await watching();
        if (ending === 'relist') await listing();
        else if (ending === 'reopen') await reopen.after();
        else if (ending === 'again') reopen.reset();
      }
    };
    run().catch((err: unknown) => broke(messageOf(err)));
    return {
      close: () => {
        closed = true;
        watch?.stop();
      },
    };
  };
}

export function informers(cluster: ClusterWatch, resources: readonly Resource[], reopen: Reopening = reopening()): Source<Listed> {
  const all = joined(resources.map((resource) => informer(cluster, resource, reopen)));
  return (listener) => all({
    change: (lists) => listener.change({ items: lists.flatMap((list) => list.items) }),
    broke: (why) => listener.broke(why),
  });
}

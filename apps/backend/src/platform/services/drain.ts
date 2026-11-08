import fs from 'node:fs/promises';
import type { Server } from 'node:http';
import { Agent } from 'undici';
import { stillRoutedTo, type EndpointSlices, type PodPlace } from '../lib/drain.js';

const LOOK_AGAIN_MS = 500;
export const PROXIES_CATCH_UP_MS = 10_000;

export interface Reconnectable {
  disconnectSockets(close: boolean): unknown;
}

export interface DrainDeps {
  place: PodPlace | undefined;
  slices?: ((namespace: string) => Promise<EndpointSlices>) | undefined;
  server: Server;
  sockets: Reconnectable;
  log: (line: string) => void;
  wait?: ((ms: number) => Promise<void>) | undefined;
}

export interface PodAccount {
  host: string;
  port: string;
  caFile: string;
  tokenFile: string;
}

export const inClusterSlices = (account: PodAccount) => async (namespace: string): Promise<EndpointSlices> => {
  const [token, ca] = await Promise.all([fs.readFile(account.tokenFile, 'utf8'), fs.readFile(account.caFile, 'utf8')]);
  const { host, port } = account;
  const answer = await fetch(`https://${host.includes(':') ? `[${host}]` : host}:${port}/apis/discovery.k8s.io/v1/namespaces/${encodeURIComponent(namespace)}/endpointslices`, {
    headers: { Authorization: `Bearer ${token.trim()}` },
    dispatcher: new Agent({ connect: { ca } }),
  } as unknown as RequestInit);
  if (!answer.ok) throw new Error(`the cluster answered ${answer.status} when asked for this namespace's endpoints`);
  return await answer.json() as EndpointSlices;
};

export async function drainThenStop(deps: DrainDeps): Promise<void> {
  if (deps.place) {
    const { slices } = deps;
    if (!slices) throw new Error('this backend runs in a pod but was given no way to read its namespace\'s endpoints, so it cannot tell when it stops being routed to');
    deps.log(`[drain] still serving until no service sends new connections to ${deps.place.ip}`);
    for (;;) {
      const routed = await slices(deps.place.namespace).then(
        (found) => stillRoutedTo(found, deps.place!.ip),
        (err: Error) => {
          deps.log(`[drain] the endpoints could not be read, so the backend drains now: ${err.message}`);
          return false;
        },
      );
      if (!routed) break;
      await new Promise((done) => setTimeout(done, LOOK_AGAIN_MS));
    }
    deps.log(`[drain] no service lists ${deps.place.ip} as ready, so it serves ${PROXIES_CATCH_UP_MS / 1000} s more while every node's proxy catches up`);
    await (deps.wait ?? ((ms) => new Promise<void>((done) => setTimeout(done, ms))))(PROXIES_CATCH_UP_MS);
  }
  deps.log('[drain] answering what still comes with Connection: close, until no connection is left');
  deps.server.prependListener('request', (_request, answer) => answer.setHeader('Connection', 'close'));
  deps.sockets.disconnectSockets(true);
  while (await openConnections(deps.server) > 0) await new Promise((done) => setTimeout(done, LOOK_AGAIN_MS));
  if (deps.server.listening) await new Promise<void>((done) => deps.server.close(() => done()));
  deps.log('[drain] no connection is left');
}

const openConnections = (server: Server): Promise<number> =>
  new Promise((done) => server.getConnections((err, count) => done(err ? 0 : count)));

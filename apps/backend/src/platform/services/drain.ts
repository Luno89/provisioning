import fs from 'node:fs/promises';
import type { Server } from 'node:http';
import { Agent } from 'undici';
import { stillRoutedTo, type EndpointSlices, type PodPlace } from '../lib/drain.js';

const ACCOUNT = '/var/run/secrets/kubernetes.io/serviceaccount';
const LOOK_AGAIN_MS = 500;

export interface Closable {
  close(): unknown;
}

export interface DrainDeps {
  place: PodPlace | undefined;
  slices?: ((namespace: string) => Promise<EndpointSlices>) | undefined;
  server: Server;
  sockets: Closable;
  log: (line: string) => void;
}

export async function inClusterSlices(namespace: string): Promise<EndpointSlices> {
  const [token, ca] = await Promise.all([fs.readFile(`${ACCOUNT}/token`, 'utf8'), fs.readFile(`${ACCOUNT}/ca.crt`, 'utf8')]);
  const host = process.env.KUBERNETES_SERVICE_HOST;
  const port = process.env.KUBERNETES_SERVICE_PORT ?? '443';
  if (!host) throw new Error('this process is not in a Kubernetes pod');
  const answer = await fetch(`https://${host.includes(':') ? `[${host}]` : host}:${port}/apis/discovery.k8s.io/v1/namespaces/${encodeURIComponent(namespace)}/endpointslices`, {
    headers: { Authorization: `Bearer ${token.trim()}` },
    dispatcher: new Agent({ connect: { ca } }),
  } as unknown as RequestInit);
  if (!answer.ok) throw new Error(`the cluster answered ${answer.status} when asked for this namespace's endpoints`);
  return await answer.json() as EndpointSlices;
}

export async function drainThenStop(deps: DrainDeps): Promise<void> {
  if (deps.place) {
    const slices = deps.slices ?? inClusterSlices;
    deps.log(`[drain] still serving until no service sends new connections to ${deps.place.ip}`);
    for (;;) {
      const routed = await slices(deps.place.namespace).then(
        (found) => stillRoutedTo(found, deps.place!.ip),
        (err: Error) => {
          deps.log(`[drain] the endpoints could not be read, so the backend stops now: ${err.message}`);
          return false;
        },
      );
      if (!routed) break;
      await new Promise((done) => setTimeout(done, LOOK_AGAIN_MS));
    }
  }
  deps.log('[drain] taking no new connections; finishing what is in flight');
  const closed = new Promise<void>((done) => deps.server.once('close', () => done()));
  deps.sockets.close();
  if (deps.server.listening) deps.server.close();
  deps.server.closeIdleConnections();
  await closed;
  deps.log('[drain] everything in flight has finished');
}

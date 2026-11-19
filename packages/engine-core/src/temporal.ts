import { Client, Connection, type ClientOptions } from '@temporalio/client';
import { NativeConnection, Worker, type ReplayWorkerOptions, type WorkerOptions } from '@temporalio/worker';
import { activityInterceptors } from './classified-failures.js';
import { WORKER_DEFAULTS } from './liveness.js';
import { buildDataConverter, type BlobReach, type SecretKey } from './payload-codec.js';

export interface TemporalPayloads {
  ring: SecretKey;
  blobs: BlobReach;
}

export const payloadConverter = (payloads: TemporalPayloads) => buildDataConverter(payloads.ring, payloads.blobs);

export interface TemporalTls {
  ca: string | Buffer;
  serverName?: string | undefined;
}

export type TemporalAuth = { apiKey: () => string; renewEveryMs: number } | { bearer: string };

export interface TemporalDial {
  address: string;
  tls: TemporalTls;
  auth: TemporalAuth;
}

const tlsOf = (tls: TemporalTls): { serverRootCACertificate: Buffer; serverNameOverride?: string } => {
  const ca = Buffer.from(tls.ca);
  if (ca.length === 0) throw new Error('Temporal\'s certificate authority was not given: Koala never talks to Temporal in plaintext');
  return { serverRootCACertificate: ca, ...(tls.serverName ? { serverNameOverride: tls.serverName } : {}) };
};

export const bearerMetadata = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

export function connectTemporal(dial: TemporalDial, side: 'client'): Promise<Connection>;
export function connectTemporal(dial: TemporalDial, side: 'worker'): Promise<NativeConnection>;
export async function connectTemporal(dial: TemporalDial, side: 'client' | 'worker'): Promise<Connection | NativeConnection> {
  const tls = tlsOf(dial.tls);
  const { auth } = dial;
  if (side === 'client') {
    return Connection.connect({ address: dial.address, tls, ...('bearer' in auth ? { metadata: bearerMetadata(auth.bearer) } : { apiKey: auth.apiKey }) });
  }
  if ('bearer' in auth) return NativeConnection.connect({ address: dial.address, tls, metadata: bearerMetadata(auth.bearer) });
  const connection = await NativeConnection.connect({ address: dial.address, tls, apiKey: auth.apiKey() });
  const renewing: NodeJS.Timeout = setInterval(() => {
    connection.setApiKey(auth.apiKey()).catch(() => clearInterval(renewing));
  }, auth.renewEveryMs);
  renewing.unref();
  return connection;
}

export type KoalaClientOptions = Omit<ClientOptions, 'dataConverter' | 'connection' | 'namespace'> & {
  connection: Connection;
  namespace: string;
  payloads: TemporalPayloads;
};

export function createClient(options: KoalaClientOptions): Client {
  const { payloads, ...rest } = options;
  return new Client({ ...rest, dataConverter: payloadConverter(payloads) });
}

export type KoalaWorkerOptions = Omit<WorkerOptions, 'dataConverter' | 'interceptors'> & {
  namespace: string;
  payloads: TemporalPayloads;
  workflowModules?: string[] | undefined;
};

export async function createWorker(options: KoalaWorkerOptions): Promise<Worker> {
  const { payloads, workflowModules, ...rest } = options;
  const dataConverter = payloadConverter(payloads);
  return Worker.create({
    ...WORKER_DEFAULTS,
    ...rest,
    dataConverter,
    interceptors: { activity: activityInterceptors(), ...(workflowModules ? { workflowModules } : {}) },
  });
}

export type KoalaReplayOptions = Omit<ReplayWorkerOptions, 'dataConverter' | 'interceptors'> & { workflowModules?: string[] | undefined };

export async function replayHistory(options: KoalaReplayOptions, history: unknown, payloads: TemporalPayloads, workflowId?: string): Promise<void> {
  const { workflowModules, ...rest } = options;
  await Worker.runReplayHistory({ ...rest, dataConverter: payloadConverter(payloads), ...(workflowModules ? { interceptors: { workflowModules } } : {}) }, history, workflowId);
}

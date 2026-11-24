import { Client, Connection, type ClientOptions } from '@temporalio/client';
import { NativeConnection, Worker, type ReplayWorkerOptions, type WorkerOptions } from '@temporalio/worker';
import { activityInterceptors } from './classified-failures.js';
import { refusingDeletingWork, type DeletingMarksHere } from './work-for.js';
import { WORKER_DEFAULTS } from './liveness.js';
import type { PayloadCodec } from '@temporalio/common';
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
    const connection = Connection.lazy({ address: dial.address, tls, ...('bearer' in auth ? { metadata: bearerMetadata(auth.bearer) } : { apiKey: auth.apiKey }) });
    try {
      await connection.ensureConnected();
    } catch (err) {
      await connection.close();
      throw err;
    }
    return connection;
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
  onUnreadable?: ((why: Error) => void) | undefined;
  deletingMarks: DeletingMarksHere;
};

const heardWhenUnreadable = (codec: PayloadCodec, heard: (why: Error) => void): PayloadCodec => ({
  encode: (payloads) => codec.encode(payloads),
  async decode(payloads) {
    try {
      return await codec.decode(payloads);
    } catch (err) {
      heard(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  },
});

export async function createWorker(options: KoalaWorkerOptions): Promise<Worker> {
  const { payloads, workflowModules, onUnreadable, deletingMarks, ...rest } = options;
  const sealed = payloadConverter(payloads);
  const dataConverter = onUnreadable ? { ...sealed, payloadCodecs: sealed.payloadCodecs.map((codec) => heardWhenUnreadable(codec, onUnreadable)) } : sealed;
  return Worker.create({
    ...WORKER_DEFAULTS,
    ...rest,
    dataConverter,
    interceptors: { activity: activityInterceptors().concat(refusingDeletingWork(deletingMarks)), ...(workflowModules ? { workflowModules } : {}) },
  });
}

const SANDBOXED: Pick<WorkerOptions, 'debugMode'> = { debugMode: false };

export type KoalaReplayOptions = Omit<ReplayWorkerOptions, 'dataConverter' | 'interceptors'> & { workflowModules?: string[] | undefined };

export async function replayHistory(options: KoalaReplayOptions, history: unknown, payloads: TemporalPayloads, workflowId?: string): Promise<void> {
  const { workflowModules, ...rest } = options;
  await Worker.runReplayHistory({ ...rest, ...SANDBOXED, dataConverter: payloadConverter(payloads), ...(workflowModules ? { interceptors: { workflowModules } } : {}) }, history, workflowId);
}

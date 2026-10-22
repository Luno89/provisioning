import { Worker, NativeConnection } from '@temporalio/worker';
import { createEventBus, type EngineEvent, type EventBus } from '@koala/agent-engine';
import { createStreamActivities, type StreamServices } from './activities.js';
import { DEFAULT_STREAM_TASK_QUEUE } from './contracts.js';
import { buildDataConverter } from '../../platform/lib/temporal-codec.js';
import { sharedPayloadBlobs } from '../../platform/lib/db-interface.js';
import type { SecretKey } from '../../platform/index.js';
import { loadKeys } from '../../platform/lib/keys.js';
import { TurnLogWriter } from '../../engine/services/TurnLogWriter.js';
import type { TurnLogEntry } from '../../engine/lib/turn-log.js';
import { heartbeatWhileRunning } from '@koala/engine-core';

export interface SocketLike {
  to(room: string): { emit(event: string, ...args: unknown[]): unknown };
}

export const userRoom = (ownerId: string): string => `user:${ownerId}`;

export interface StreamWorkerOptions {
  services: Omit<StreamServices, 'bus'>;
  io: SocketLike;
  turnLogs: { appendTurnLog(entry: TurnLogEntry): Promise<void>; lastTurnLogSeq(turnId: string): Promise<number> };
  address?: string | undefined;
  namespace?: string | undefined;
  taskQueue?: string | undefined;
  encryptionKey?: SecretKey | undefined;
}

export const TURN_LOG_CHANNEL = 'turn-log';
export const GROVE_CHANGED = 'grove-changed';

export const notifyGroveChanged = (io: SocketLike) => (ownerId: string): void => {
  io.to(userRoom(ownerId)).emit(GROVE_CHANGED, {});
};

export const notifyTurnLog = (io: SocketLike) => (entry: TurnLogEntry): void => {
  const { ownerId, ...rest } = entry;
  try {
    io.to(userRoom(ownerId)).emit(TURN_LOG_CHANNEL, rest);
  } catch (err) {
    console.warn(`[turn-log] could not tell ${ownerId}'s browsers about turn ${entry.turnId}: ${(err as Error).message}`);
  }
};

export function createTurnLogBus(options: Pick<StreamWorkerOptions, 'io' | 'turnLogs'>): EventBus {
  const bus = createEventBus({ retain: 0 });
  const writer = new TurnLogWriter({ store: options.turnLogs, notify: notifyTurnLog(options.io) });
  bus.subscribe((event: EngineEvent) => writer.accept(event));
  return bus;
}

export async function startStreamWorker(options: StreamWorkerOptions): Promise<Worker> {
  const connection = await NativeConnection.connect({
    address: options.address ?? process.env.TEMPORAL_CONNECTION_ADDRESS ?? 'localhost:7233',
  });

  const bus = createTurnLogBus(options);
  const dataConverter = buildDataConverter(options.encryptionKey ?? loadKeys(process.env).payload, sharedPayloadBlobs());

  return Worker.create({
    connection,
    ...(dataConverter ? { dataConverter } : {}),
    taskQueue: options.taskQueue ?? DEFAULT_STREAM_TASK_QUEUE,
    interceptors: { activity: [heartbeatWhileRunning()] },
    ...(options.namespace ? { namespace: options.namespace } : {}),
    activities: createStreamActivities({ ...options.services, bus, groveChanged: notifyGroveChanged(options.io) }),
  });
}

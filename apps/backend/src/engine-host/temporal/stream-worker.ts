import type { Worker } from '@temporalio/worker';
import { createWorker } from '@koala/engine-core/temporal';
import { createEventBus, type EngineEvent, type EventBus } from '@koala/agent-engine';
import { createStreamActivities, type StreamServices } from './activities.js';
import { DEFAULT_STREAM_TASK_QUEUE } from './contracts.js';
import { sharedPayloadBlobs } from '../../platform/lib/db-interface.js';
import type { PlatformKeys } from '../../platform/index.js';
import { connectTemporalWorker, type TemporalPlace } from '../../platform/lib/temporal-connection.js';
import { givenDeletingMarks } from '../../platform/lib/temporal-client.js';
import { TurnLogWriter, type TurnLogEntry } from '../../engine/index.js';
import { PROJECT_DELETION, ProjectDeletionNotices, type ProjectDeletionEvent, type ProjectDeletionNoticesDeps } from '../../projects/index.js';

export interface SocketLike {
  to(room: string): { emit(event: string, ...args: unknown[]): unknown };
}

export const userRoom = (ownerId: string): string => `user:${ownerId}`;

export interface StreamWorkerOptions {
  services: Omit<StreamServices, 'bus'>;
  io: SocketLike;
  turnLogs: { appendTurnLog(entry: TurnLogEntry): Promise<void>; lastTurnLogSeq(turnId: string): Promise<number> };
  deletions: Omit<ProjectDeletionNoticesDeps, 'emit'>;
  connection: { temporal: TemporalPlace; keys: Pick<PlatformKeys, 'temporal' | 'payload'> };
  taskQueue?: string | undefined;
}

export const TURN_LOG_CHANNEL = 'turn-log';
export const GROVE_CHANGED = 'grove-changed';

export const notifyGroveChanged = (io: SocketLike) => (ownerId: string): void => {
  io.to(userRoom(ownerId)).emit(GROVE_CHANGED, {});
};

export const notifyProjectDeletion = (io: SocketLike) => (ownerId: string, event: ProjectDeletionEvent): void => {
  io.to(userRoom(ownerId)).emit(PROJECT_DELETION, event);
};

export const notifyTurnLog =(io: SocketLike) => (entry: TurnLogEntry): void => {
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
  const connection = await connectTemporalWorker('koala-stream-worker', options.connection);

  const bus = createTurnLogBus(options);
  const deletions = new ProjectDeletionNotices({ ...options.deletions, emit: notifyProjectDeletion(options.io) });
  return createWorker({
    connection,
    payloads: { ring: options.connection.keys.payload, blobs: sharedPayloadBlobs() },
    taskQueue: options.taskQueue ?? DEFAULT_STREAM_TASK_QUEUE,
    namespace: options.connection.temporal.namespace,
    activities: createStreamActivities({ ...options.services, bus, groveChanged: notifyGroveChanged(options.io), deletionChanged: (change) => deletions.changed(change) }),
    deletingMarks: givenDeletingMarks(),
  });
}

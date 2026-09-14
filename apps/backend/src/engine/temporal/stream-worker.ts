import { Worker, NativeConnection } from '@temporalio/worker';
import { createEventBus, type EngineEvent, type EventBus } from '../events.js';
import { createStreamActivities, type StreamServices } from './activities.js';
import { DEFAULT_STREAM_TASK_QUEUE } from './contracts.js';

export interface SocketLike {
  emit(event: string, ...args: unknown[]): unknown;
}

export interface StreamWorkerOptions {
  services: Omit<StreamServices, 'bus'>;
  io: SocketLike;
  address?: string | undefined;
  namespace?: string | undefined;
  taskQueue?: string | undefined;
  channel?: string | undefined;
}

export const ENGINE_EVENT_CHANNEL = 'engine-event';

export function createBrowserBus(io: SocketLike, channel: string = ENGINE_EVENT_CHANNEL): EventBus {
  const bus = createEventBus({ retain: 500 });
  bus.subscribe((event: EngineEvent) => {
    io.emit(channel, event);
  });
  return bus;
}

export async function startStreamWorker(options: StreamWorkerOptions): Promise<Worker> {
  const connection = await NativeConnection.connect({
    address: options.address ?? process.env.TEMPORAL_CONNECTION_ADDRESS ?? 'localhost:7233',
  });

  const bus = createBrowserBus(options.io, options.channel);

  return Worker.create({
    connection,
    taskQueue: options.taskQueue ?? DEFAULT_STREAM_TASK_QUEUE,
    ...(options.namespace ? { namespace: options.namespace } : {}),
    activities: createStreamActivities({ ...options.services, bus }),
  });
}

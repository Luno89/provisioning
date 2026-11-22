export interface HistoryEvent {
  eventId?: number | string | { toString(): string } | null | undefined;
  activityTaskScheduledEventAttributes?: { taskQueue?: { name?: string | null | undefined } | null | undefined } | null | undefined;
  activityTaskStartedEventAttributes?: { scheduledEventId?: unknown; identity?: string | null | undefined } | null | undefined;
  activityTaskCancelRequestedEventAttributes?: { scheduledEventId?: unknown } | null | undefined;
  activityTaskCanceledEventAttributes?: { scheduledEventId?: unknown; details?: { payloads?: readonly CancelPayload[] | null | undefined } | null | undefined } | null | undefined;
  activityTaskTimedOutEventAttributes?: { scheduledEventId?: unknown; failure?: { timeoutFailureInfo?: { timeoutType?: unknown } | null | undefined } | null | undefined } | null | undefined;
}

export interface CancelPayload {
  metadata?: Record<string, Uint8Array> | null | undefined;
  data?: Uint8Array | null | undefined;
}

const HEARTBEAT = new Set<unknown>(['TIMEOUT_TYPE_HEARTBEAT', 4]);

export function cancelledDetailsIn(events: readonly HistoryEvent[]): CancelPayload[][] {
  return events.flatMap((event) => {
    const payloads = event.activityTaskCanceledEventAttributes?.details?.payloads;
    return payloads?.length ? [[...payloads]] : [];
  });
}

const isKilled = (detail: unknown): detail is { killed: string[] } => {
  const killed = (detail as { killed?: unknown } | null)?.killed;
  return Array.isArray(killed) && killed.every((program) => typeof program === 'string');
};

export function killedIn(details: readonly unknown[]): string[] {
  return [...new Set(details.filter(isKilled).flatMap((detail) => detail.killed))];
}

const idOf = (value: unknown): string => String(value ?? '');

const DEVICE_QUEUE = /^device-(.+)$/;

interface Lapsed {
  worker: string | undefined;
  device: string | undefined;
}

function lapsedWhenAskedToStop(events: readonly HistoryEvent[]): Lapsed[] {
  const asked = new Set<string>();
  const ranOn = new Map<string, string>();
  const queues = new Map<string, string>();
  const lapsed: Lapsed[] = [];
  for (const event of events) {
    const queue = event.activityTaskScheduledEventAttributes?.taskQueue?.name;
    if (queue) queues.set(idOf(event.eventId), queue);
    if (event.activityTaskCancelRequestedEventAttributes) asked.add(idOf(event.activityTaskCancelRequestedEventAttributes.scheduledEventId));
    const start = event.activityTaskStartedEventAttributes;
    if (start?.identity) ranOn.set(idOf(start.scheduledEventId), start.identity);
    const timedOut = event.activityTaskTimedOutEventAttributes;
    if (!timedOut || !HEARTBEAT.has(timedOut.failure?.timeoutFailureInfo?.timeoutType)) continue;
    const scheduled = idOf(timedOut.scheduledEventId);
    if (asked.has(scheduled)) lapsed.push({ worker: ranOn.get(scheduled), device: DEVICE_QUEUE.exec(queues.get(scheduled) ?? '')?.[1] });
  }
  return lapsed;
}

export function frozenWorkersIn(events: readonly HistoryEvent[]): string[] {
  return [...new Set(lapsedWhenAskedToStop(events).flatMap(({ worker, device }) => (worker && device === undefined ? [worker] : [])))];
}

export function machinesOffIn(events: readonly HistoryEvent[]): string[] {
  return [...new Set(lapsedWhenAskedToStop(events).flatMap(({ device }) => (device === undefined ? [] : [device])))];
}

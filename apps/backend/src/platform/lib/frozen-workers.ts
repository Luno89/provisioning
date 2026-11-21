export interface HistoryEvent {
  eventId?: number | string | { toString(): string } | null | undefined;
  activityTaskScheduledEventAttributes?: object | null | undefined;
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

export function frozenWorkersIn(events: readonly HistoryEvent[]): string[] {
  const asked = new Set<string>();
  const ranOn = new Map<string, string>();
  const frozen = new Set<string>();
  for (const event of events) {
    if (event.activityTaskCancelRequestedEventAttributes) asked.add(idOf(event.activityTaskCancelRequestedEventAttributes.scheduledEventId));
    const start = event.activityTaskStartedEventAttributes;
    if (start?.identity) ranOn.set(idOf(start.scheduledEventId), start.identity);
    const timedOut = event.activityTaskTimedOutEventAttributes;
    if (!timedOut || !HEARTBEAT.has(timedOut.failure?.timeoutFailureInfo?.timeoutType)) continue;
    const scheduled = idOf(timedOut.scheduledEventId);
    const worker = ranOn.get(scheduled);
    if (worker && asked.has(scheduled)) frozen.add(worker);
  }
  return [...frozen];
}

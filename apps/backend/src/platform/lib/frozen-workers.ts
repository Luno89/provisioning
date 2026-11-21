export interface HistoryEvent {
  eventId?: number | string | { toString(): string } | null | undefined;
  activityTaskScheduledEventAttributes?: object | null | undefined;
  activityTaskStartedEventAttributes?: { scheduledEventId?: unknown; identity?: string | null | undefined } | null | undefined;
  activityTaskCancelRequestedEventAttributes?: { scheduledEventId?: unknown } | null | undefined;
  activityTaskCanceledEventAttributes?: { scheduledEventId?: unknown } | null | undefined;
  activityTaskTimedOutEventAttributes?: { scheduledEventId?: unknown; failure?: { timeoutFailureInfo?: { timeoutType?: unknown } | null | undefined } | null | undefined } | null | undefined;
}

const HEARTBEAT = new Set<unknown>(['TIMEOUT_TYPE_HEARTBEAT', 4]);

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

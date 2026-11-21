import { describe, expect, it } from 'vitest';
import { frozenWorkersIn, type HistoryEvent } from './frozen-workers.js';

const scheduled = (id: number): HistoryEvent => ({ eventId: id, activityTaskScheduledEventAttributes: {} });
const started = (id: number, of: number, identity: string): HistoryEvent => ({ eventId: id, activityTaskStartedEventAttributes: { scheduledEventId: of, identity } });
const cancelAsked = (id: number, of: number): HistoryEvent => ({ eventId: id, activityTaskCancelRequestedEventAttributes: { scheduledEventId: of } });
const timedOut = (id: number, of: number, timeoutType: string | number): HistoryEvent => ({ eventId: id, activityTaskTimedOutEventAttributes: { scheduledEventId: of, failure: { timeoutFailureInfo: { timeoutType } } } });

describe('a worker that stopped answering while its work was being cancelled, read from Temporal\'s own history', () => {
  it('is the worker an activity ran on whose heartbeat Temporal timed out after it was asked to cancel', () => {
    expect(frozenWorkersIn([scheduled(5), cancelAsked(9, 5), started(10, 5, 'worker-engine-7d9f-abcde'), timedOut(11, 5, 'TIMEOUT_TYPE_HEARTBEAT')])).toEqual(['worker-engine-7d9f-abcde']);
    expect(frozenWorkersIn([scheduled(5), cancelAsked(9, 5), started(10, 5, 'worker-cluster-1'), timedOut(11, 5, 4)])).toEqual(['worker-cluster-1']);
  });

  it('is no worker when the activity stopped on its own, timed out without being asked to stop, or timed out some other way', () => {
    expect(frozenWorkersIn([scheduled(5), cancelAsked(9, 5), started(10, 5, 'w1'), { eventId: 11, activityTaskCanceledEventAttributes: { scheduledEventId: 5 } }])).toEqual([]);
    expect(frozenWorkersIn([scheduled(5), started(10, 5, 'w1'), timedOut(11, 5, 'TIMEOUT_TYPE_HEARTBEAT')])).toEqual([]);
    expect(frozenWorkersIn([scheduled(5), cancelAsked(9, 5), started(10, 5, 'w1'), timedOut(11, 5, 'TIMEOUT_TYPE_START_TO_CLOSE')])).toEqual([]);
  });

  it('names each worker once', () => {
    expect(frozenWorkersIn([
      scheduled(5), scheduled(6), cancelAsked(8, 5), cancelAsked(9, 6),
      started(10, 5, 'w1'), started(11, 6, 'w1'), timedOut(12, 5, 'TIMEOUT_TYPE_HEARTBEAT'), timedOut(13, 6, 'TIMEOUT_TYPE_HEARTBEAT'),
    ])).toEqual(['w1']);
  });
});

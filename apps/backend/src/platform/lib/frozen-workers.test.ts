import { describe, expect, it } from 'vitest';
import { cancelledDetailsIn, frozenWorkersIn, killedIn, machinesOffIn, type HistoryEvent } from './frozen-workers.js';

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

  it('takes the details each cancelled activity reported, and none from activities that ended otherwise', () => {
    const payload = { metadata: {}, data: new Uint8Array([1]) };
    expect(cancelledDetailsIn([
      scheduled(5), cancelAsked(9, 5), { eventId: 11, activityTaskCanceledEventAttributes: { scheduledEventId: 5, details: { payloads: [payload] } } },
      { eventId: 12, activityTaskCanceledEventAttributes: { scheduledEventId: 6 } },
      timedOut(13, 7, 'TIMEOUT_TYPE_HEARTBEAT'),
    ])).toEqual([[payload]]);
  });

  it('names each program a cancelled activity killed once, in the order they were killed, ignoring details of another shape', () => {
    expect(killedIn([{ killed: ['terraform', 'kubectl'] }, { killed: ['kubectl', 'git'] }, 'cancelled', { killed: 'helm' }, { killed: [3] }])).toEqual(['terraform', 'kubectl', 'git']);
  });

  it('is the machine whose own queue held an activity whose heartbeat timed out after it was asked to cancel, and no worker to restart', () => {
    const scheduledOn = (id: number, queue: string): HistoryEvent => ({ eventId: id, activityTaskScheduledEventAttributes: { taskQueue: { name: queue } } });
    const events = [
      scheduledOn(5, 'device-desk'), scheduledOn(6, 'device-desk'), scheduledOn(7, 'device-tower'), scheduledOn(8, 'engine'),
      cancelAsked(9, 5), cancelAsked(10, 6), cancelAsked(11, 7), cancelAsked(12, 8),
      started(13, 5, 'agent-desk'), started(14, 6, 'agent-desk'), started(15, 7, 'agent-tower'), started(16, 8, 'worker-engine-7d9f'),
      timedOut(17, 5, 'TIMEOUT_TYPE_HEARTBEAT'), timedOut(18, 6, 'TIMEOUT_TYPE_HEARTBEAT'),
      { eventId: 19, activityTaskCanceledEventAttributes: { scheduledEventId: 7 } },
      timedOut(20, 8, 'TIMEOUT_TYPE_HEARTBEAT'),
    ];
    expect(machinesOffIn(events)).toEqual(['desk']);
    expect(frozenWorkersIn(events)).toEqual(['worker-engine-7d9f']);
  });

  it('names each worker once', () => {
    expect(frozenWorkersIn([
      scheduled(5), scheduled(6), cancelAsked(8, 5), cancelAsked(9, 6),
      started(10, 5, 'w1'), started(11, 6, 'w1'), timedOut(12, 5, 'TIMEOUT_TYPE_HEARTBEAT'), timedOut(13, 6, 'TIMEOUT_TYPE_HEARTBEAT'),
    ])).toEqual(['w1']);
  });
});

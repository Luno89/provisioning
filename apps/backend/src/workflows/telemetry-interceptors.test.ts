import { describe, expect, it } from 'vitest';
import type { Headers } from '@temporalio/common';
import { interceptors, traceHeadersOf, withTrace } from './telemetry-interceptors.js';

const payload = (text: string) => ({ metadata: { encoding: new TextEncoder().encode('json/plain') }, data: new TextEncoder().encode(JSON.stringify(text)) });
const traceparent = payload('00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01');
const other = payload('something else');

describe('the trace a workflow was started under follows its activities and children', () => {
  it('keeps only the trace headers from what the workflow was started with', () => {
    expect(traceHeadersOf({ traceparent, other })).toEqual({ traceparent });
    expect(traceHeadersOf(undefined)).toEqual({});
    expect(withTrace({ other }, { traceparent })).toEqual({ other, traceparent });
  });

  it('puts them on every activity, local activity, child workflow and continue-as-new the workflow schedules', async () => {
    const { inbound, outbound } = interceptors();
    const scheduled: Headers[] = [];
    const next = async <I extends { headers: Headers }>(input: I) => { scheduled.push(input.headers); return input; };

    await outbound![0]!.scheduleActivity!({ activityType: 'Early', args: [], headers: {}, options: {}, seq: 1 } as never, next as never);
    expect(scheduled[0]).toEqual({});

    await inbound![0]!.execute!({ args: [], headers: { traceparent, other } } as never, (async () => undefined) as never);
    await outbound![0]!.scheduleActivity!({ activityType: 'A', args: [], headers: { other }, options: {}, seq: 2 } as never, next as never);
    await outbound![0]!.scheduleLocalActivity!({ activityType: 'B', args: [], headers: {}, options: {}, seq: 3, originalScheduleTime: undefined, attempt: 1, activityId: 'b' } as never, next as never);
    await outbound![0]!.startChildWorkflowExecution!({ workflowType: 'Child', options: {}, headers: {}, seq: 4 } as never, next as never);
    await outbound![0]!.continueAsNew!({ args: [], headers: {}, options: {} } as never, next as never);
    expect(scheduled.slice(1)).toEqual([{ other, traceparent }, { traceparent }, { traceparent }, { traceparent }]);
  });

  it('is a fresh carrier for each workflow run', async () => {
    const first = interceptors();
    const second = interceptors();
    await first.inbound![0]!.execute!({ args: [], headers: { traceparent } } as never, (async () => undefined) as never);
    const seen: Headers[] = [];
    await second.outbound![0]!.scheduleActivity!({ activityType: 'A', args: [], headers: {}, options: {}, seq: 1 } as never, (async (input: { headers: Headers }) => { seen.push(input.headers); }) as never);
    expect(seen).toEqual([{}]);
  });
});

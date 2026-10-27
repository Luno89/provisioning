import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { temporal } from '@temporalio/proto';
import { frame, gatewayCallOf, gatewayDecision, sealedPollAnswer, unframe, unsealToken, withBytesField, wireFields } from './temporal-gateway.js';

const ws = temporal.api.workflowservice.v1;
const bytes = (encoded: { finish(): Uint8Array }): Buffer => Buffer.from(encoded.finish());
const machine = { deviceId: 'd1', namespace: 'default', keys: ['the-key'] };

describe('what a machine may ask Temporal', () => {
  it('names only the calls an activity worker makes', () => {
    expect(gatewayCallOf('/temporal.api.workflowservice.v1.WorkflowService/PollActivityTaskQueue')).toBe('PollActivityTaskQueue');
    for (const path of ['/temporal.api.workflowservice.v1.WorkflowService/ListWorkflowExecutions', '/temporal.api.workflowservice.v1.WorkflowService/GetWorkflowExecutionHistory',
      '/temporal.api.workflowservice.v1.WorkflowService/SignalWorkflowExecution', '/temporal.api.workflowservice.v1.WorkflowService/StartWorkflowExecution',
      '/temporal.api.workflowservice.v1.WorkflowService/RespondActivityTaskCompletedById', '/temporal.api.operatorservice.v1.OperatorService/AddSearchAttributes']) {
      expect(gatewayCallOf(path), path).toBeUndefined();
    }
  });

  it('takes work only from the machine\'s own queue, in the instance\'s namespace', () => {
    const poll = (queue: string, namespace = 'default') => bytes(ws.PollActivityTaskQueueRequest.encode({ namespace, taskQueue: { name: queue }, identity: 'w' }));
    expect(gatewayDecision('PollActivityTaskQueue', poll('device-d1'), machine)).toEqual({ forward: poll('device-d1') });
    expect(gatewayDecision('PollActivityTaskQueue', poll('device-d2'), machine)).toEqual({ refused: 'a machine takes work only from its own queue, device-d1' });
    expect(gatewayDecision('PollActivityTaskQueue', poll('engine-queue'), machine)).toMatchObject({ refused: expect.any(String) });
    expect(gatewayDecision('PollActivityTaskQueue', poll('device-d1', 'other'), machine)).toEqual({ refused: 'a machine works only in the namespace default' });
    expect(gatewayDecision('DescribeNamespace', bytes(ws.DescribeNamespaceRequest.encode({ namespace: 'default' })), machine)).toMatchObject({ forward: expect.any(Buffer) });
    expect(gatewayDecision('GetSystemInfo', Buffer.alloc(0), machine)).toEqual({ forward: Buffer.alloc(0) });
  });

  it('hands out a task sealed to the machine, and takes an answer only with that seal, forwarding Temporal\'s own token', () => {
    const token = Buffer.from('temporal-task-token');
    const answer = bytes(ws.PollActivityTaskQueueResponse.encode({ taskToken: token, workflowNamespace: 'default', activityId: '7', attempt: 2 }));
    const sealed = sealedPollAnswer(answer, 'd1', 'the-key');
    const handed = ws.PollActivityTaskQueueResponse.decode(sealed);
    expect([handed.activityId, handed.attempt, handed.workflowNamespace]).toEqual(['7', 2, 'default']);
    const handedToken = Buffer.from(handed.taskToken);
    expect(unsealToken(handedToken, 'd1', ['the-key'])).toEqual(token);
    expect(unsealToken(handedToken, 'd2', ['the-key'])).toBeUndefined();

    const complete = (taskToken: Buffer) => bytes(ws.RespondActivityTaskCompletedRequest.encode({ taskToken, namespace: 'default', identity: 'w', result: { payloads: [{ data: Buffer.from('ok') }] } }));
    const decided = gatewayDecision('RespondActivityTaskCompleted', complete(handedToken), machine);
    expect('forward' in decided && Buffer.from(ws.RespondActivityTaskCompletedRequest.decode(decided.forward).taskToken)).toEqual(token);
    expect('forward' in decided && Buffer.from(ws.RespondActivityTaskCompletedRequest.decode(decided.forward).result!.payloads![0]!.data!).toString()).toBe('ok');

    expect(gatewayDecision('RespondActivityTaskCompleted', complete(token), machine)).toEqual({ refused: 'a machine answers only for the tasks it was handed' });
    expect(gatewayDecision('RecordActivityTaskHeartbeat', complete(handedToken), { ...machine, deviceId: 'd2' })).toEqual({ refused: 'a machine answers only for the tasks it was handed' });
    expect(gatewayDecision('RespondActivityTaskFailed', complete(handedToken), { ...machine, keys: ['another-key'] })).toMatchObject({ refused: expect.any(String) });
    expect(gatewayDecision('RespondActivityTaskCanceled', complete(handedToken), { ...machine, keys: ['another-key', 'the-key'] })).toMatchObject({ forward: expect.any(Buffer) });
  });

  it('leaves an empty poll, and every field it does not touch, exactly as Temporal sent it', () => {
    expect(sealedPollAnswer(Buffer.alloc(0), 'd1', 'k')).toEqual(Buffer.alloc(0));
    const unknown = Buffer.concat([bytes(ws.PollActivityTaskQueueResponse.encode({ taskToken: Buffer.from('t') })), Buffer.from([0xfa, 0x3e, 0x02, 0x68, 0x69])]);
    const sealed = sealedPollAnswer(unknown, 'd1', 'k');
    expect(sealed.subarray(sealed.length - 5)).toEqual(Buffer.from([0xfa, 0x3e, 0x02, 0x68, 0x69]));
    expect(wireFields(withBytesField(unknown, 1, Buffer.from('x'))).map((field) => field.number)).toEqual([1, 1007]);
  });

  it('reads and writes a gRPC frame, compressed or not', () => {
    const message = Buffer.from('hello');
    expect(unframe(frame(message), undefined)).toEqual(message);
    const zipped = zlib.gzipSync(message);
    const compressed = Buffer.concat([Buffer.from([1, 0, 0, 0, zipped.length]), zipped]);
    expect(unframe(compressed, 'gzip')).toEqual(message);
    expect(() => unframe(compressed, 'snappy')).toThrow(/snappy/);
  });
});

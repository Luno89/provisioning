import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { encodeVarint, wireFields } from './protobuf-wire.js';

export const WORKFLOW_SERVICE = '/temporal.api.workflowservice.v1.WorkflowService/';

export type GatewayCall =
  | 'GetSystemInfo'
  | 'DescribeNamespace'
  | 'PollActivityTaskQueue'
  | 'RecordActivityTaskHeartbeat'
  | 'RespondActivityTaskCompleted'
  | 'RespondActivityTaskFailed'
  | 'RespondActivityTaskCanceled'
  | 'ShutdownWorker';

export const GATEWAY_CALLS: readonly GatewayCall[] = [
  'GetSystemInfo', 'DescribeNamespace', 'PollActivityTaskQueue', 'RecordActivityTaskHeartbeat',
  'RespondActivityTaskCompleted', 'RespondActivityTaskFailed', 'RespondActivityTaskCanceled', 'ShutdownWorker',
];

const ON_A_TASK: ReadonlySet<GatewayCall> = new Set(['RecordActivityTaskHeartbeat', 'RespondActivityTaskCompleted', 'RespondActivityTaskFailed', 'RespondActivityTaskCanceled']);

const NAMESPACE_FIELD: Record<GatewayCall, number | undefined> = {
  GetSystemInfo: undefined,
  DescribeNamespace: 1,
  PollActivityTaskQueue: 1,
  ShutdownWorker: 1,
  RecordActivityTaskHeartbeat: 4,
  RespondActivityTaskCompleted: 4,
  RespondActivityTaskFailed: 4,
  RespondActivityTaskCanceled: 4,
};

const TASK_TOKEN_FIELD = 1;
const TASK_QUEUE_FIELD = 2;
const TASK_QUEUE_NAME_FIELD = 1;
const WORKFLOW_EXECUTION_FIELD = 4;
const WORKFLOW_ID_FIELD = 1;

export const deviceQueueOf = (deviceId: string): string => `device-${deviceId}`;

export function gatewayCallOf(path: string): GatewayCall | undefined {
  if (!path.startsWith(WORKFLOW_SERVICE)) return undefined;
  const name = path.slice(WORKFLOW_SERVICE.length);
  return (GATEWAY_CALLS as readonly string[]).includes(name) ? name as GatewayCall : undefined;
}

const bytesField = (message: Buffer, number: number): Buffer | undefined => wireFields(message).find((field) => field.number === number && field.value)?.value;

export function withBytesField(message: Buffer, number: number, value: Buffer): Buffer {
  const parts = wireFields(message).map((field) => (field.number === number && field.value
    ? Buffer.concat([encodeVarint(number * 8 + 2), encodeVarint(value.length), value])
    : message.subarray(field.start, field.end)));
  return Buffer.concat(parts);
}

export function unframe(body: Buffer, encoding: string | undefined): Buffer {
  if (body.length < 5) throw new Error('a gRPC message was shorter than its frame');
  const length = body.readUInt32BE(1);
  const message = body.subarray(5, 5 + length);
  if (body[0] === 0) return message;
  if (encoding === 'gzip') return zlib.gunzipSync(message);
  throw new Error(`a gRPC message compressed as ${encoding ?? 'nothing named'} cannot be read here`);
}

export function frame(message: Buffer): Buffer {
  const head = Buffer.alloc(5);
  head.writeUInt32BE(message.length, 1);
  return Buffer.concat([head, message]);
}

export interface GatewayRequest {
  namespace?: string | undefined;
  taskQueue?: string | undefined;
  taskToken?: Buffer | undefined;
}

export function gatewayRequestOf(call: GatewayCall, message: Buffer): GatewayRequest {
  const namespaceField = NAMESPACE_FIELD[call];
  const namespace = namespaceField === undefined ? undefined : bytesField(message, namespaceField)?.toString('utf8');
  const queue = call === 'PollActivityTaskQueue' ? bytesField(message, TASK_QUEUE_FIELD) : undefined;
  return {
    ...(namespace !== undefined ? { namespace } : {}),
    ...(queue ? { taskQueue: bytesField(queue, TASK_QUEUE_NAME_FIELD)?.toString('utf8') ?? '' } : {}),
    ...(ON_A_TASK.has(call) ? { taskToken: bytesField(message, TASK_TOKEN_FIELD) } : {}),
  };
}

const SEAL = Buffer.from('KGW1');
const MAC_LENGTH = 32;

const macOf = (key: string, deviceId: string, token: Buffer): Buffer =>
  crypto.createHmac('sha256', key).update(`machine-task:${deviceId}:`).update(token).digest();

export const sealToken = (token: Buffer, deviceId: string, key: string): Buffer => Buffer.concat([token, macOf(key, deviceId, token), SEAL]);

export function unsealToken(sealed: Buffer, deviceId: string, keys: readonly string[]): Buffer | undefined {
  if (sealed.length <= MAC_LENGTH + SEAL.length || !sealed.subarray(sealed.length - SEAL.length).equals(SEAL)) return undefined;
  const token = sealed.subarray(0, sealed.length - MAC_LENGTH - SEAL.length);
  const mac = sealed.subarray(sealed.length - MAC_LENGTH - SEAL.length, sealed.length - SEAL.length);
  return keys.some((key) => crypto.timingSafeEqual(mac, macOf(key, deviceId, token))) ? token : undefined;
}

export function handedWorkflowOf(answer: Buffer): string | undefined {
  const token = bytesField(answer, TASK_TOKEN_FIELD);
  if (!token || token.length === 0) return undefined;
  const execution = bytesField(answer, WORKFLOW_EXECUTION_FIELD);
  const workflowId = execution ? bytesField(execution, WORKFLOW_ID_FIELD)?.toString('utf8') : undefined;
  return workflowId || undefined;
}

export const sealedPollAnswer = (message: Buffer, deviceId: string, key: string): Buffer => {
  const token = bytesField(message, TASK_TOKEN_FIELD);
  return token && token.length > 0 ? withBytesField(message, TASK_TOKEN_FIELD, sealToken(token, deviceId, key)) : message;
};

export type GatewayDecision = { forward: Buffer } | { refused: string };

export function gatewayDecision(
  call: GatewayCall,
  message: Buffer,
  machine: { deviceId: string; namespace: string; keys: readonly string[] },
): GatewayDecision {
  const request = gatewayRequestOf(call, message);
  if (call !== 'GetSystemInfo' && request.namespace !== machine.namespace) return { refused: `a machine works only in the namespace ${machine.namespace}` };
  if (call === 'PollActivityTaskQueue' && request.taskQueue !== deviceQueueOf(machine.deviceId)) {
    return { refused: `a machine takes work only from its own queue, ${deviceQueueOf(machine.deviceId)}` };
  }
  if (!ON_A_TASK.has(call)) return { forward: message };
  const token = request.taskToken ? unsealToken(request.taskToken, machine.deviceId, machine.keys) : undefined;
  if (!token) return { refused: 'a machine answers only for the tasks it was handed' };
  return { forward: withBytesField(message, TASK_TOKEN_FIELD, token) };
}

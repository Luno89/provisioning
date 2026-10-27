import crypto from 'node:crypto';
import zlib from 'node:zlib';

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

interface WireField { number: number; start: number; end: number; value?: Buffer | undefined }

function varint(buffer: Buffer, at: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  for (let index = at; index < buffer.length; index += 1) {
    const byte = buffer[index]!;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, next: index + 1 };
    shift += 7;
    if (shift > 63) break;
  }
  throw new Error('a protobuf varint ran past the message');
}

const encodeVarint = (value: number): Buffer => {
  const bytes: number[] = [];
  let rest = value;
  while (rest >= 0x80) { bytes.push((rest % 0x80) | 0x80); rest = Math.floor(rest / 0x80); }
  bytes.push(rest);
  return Buffer.from(bytes);
};

export function wireFields(message: Buffer): WireField[] {
  const fields: WireField[] = [];
  let at = 0;
  while (at < message.length) {
    const start = at;
    const key = varint(message, at);
    const number = Math.floor(key.value / 8);
    const type = key.value % 8;
    at = key.next;
    if (type === 0) at = varint(message, at).next;
    else if (type === 1) at += 8;
    else if (type === 5) at += 4;
    else if (type === 2) {
      const length = varint(message, at);
      const value = message.subarray(length.next, length.next + length.value);
      if (value.length !== length.value) throw new Error('a protobuf field ran past the message');
      at = length.next + length.value;
      fields.push({ number, start, end: at, value });
      continue;
    } else throw new Error(`a protobuf field of wire type ${type} cannot be read here`);
    if (at > message.length) throw new Error('a protobuf field ran past the message');
    fields.push({ number, start, end: at });
  }
  return fields;
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

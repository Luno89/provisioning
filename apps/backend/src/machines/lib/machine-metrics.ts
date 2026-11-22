import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { compress, uncompress } from 'snappyjs';
import { CLUSTER_LABEL } from '../../monitoring/lib/cluster-scope.js';
import { encodeVarint, wireFields } from './protobuf-wire.js';

export const METRICS_MAX_BYTES = 32 * 1024 * 1024;

const lengthDelimited = (number: number, value: Buffer) => Buffer.concat([encodeVarint(number * 8 + 2), encodeVarint(value.length), value]);

const labelOf = (name: string, value: string) => lengthDelimited(1, Buffer.concat([lengthDelimited(1, Buffer.from(name)), lengthDelimited(2, Buffer.from(value))]));

const nameOf = (label: Buffer) => wireFields(label).find((field) => field.number === 1)?.value?.toString() ?? '';

function stampedSeries(series: Buffer, cluster: string): Buffer {
  const fields = wireFields(series);
  const labels = fields.filter((field) => field.number === 1 && field.value)
    .map((field) => ({ name: nameOf(field.value!), bytes: series.subarray(field.start, field.end) }))
    .filter((label) => label.name !== CLUSTER_LABEL);
  labels.push({ name: CLUSTER_LABEL, bytes: labelOf(CLUSTER_LABEL, cluster) });
  labels.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const rest = fields.filter((field) => field.number !== 1).map((field) => series.subarray(field.start, field.end));
  return Buffer.concat([...labels.map((label) => label.bytes), ...rest]);
}

export function stampedWrite(request: Buffer, cluster: string): Buffer {
  return Buffer.concat(wireFields(request).map((field) => (field.number === 1 && field.value
    ? lengthDelimited(1, stampedSeries(field.value, cluster))
    : request.subarray(field.start, field.end))));
}

export function stampedBody(body: Buffer, cluster: string): Buffer {
  const request = Buffer.from(uncompress(body, METRICS_MAX_BYTES));
  return Buffer.from(compress(stampedWrite(request, cluster)));
}


export const metricsTokenHash = (token: string): string => createHash('sha256').update(token).digest('hex');

export function hashesEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

export function newMetricsToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: metricsTokenHash(token) };
}

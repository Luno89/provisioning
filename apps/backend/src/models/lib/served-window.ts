import type { ModelKind } from './model-registry.js';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const windowOf = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined);

const listedWindow = (entry: Record<string, unknown>): number | undefined => windowOf(entry.max_model_len) ?? windowOf(entry.context_length);

export const servedWindowPath = (kind: ModelKind | undefined): string => (kind === 'tabbyapi' ? '/model' : '/models');

export function servedWindowFrom(kind: ModelKind | undefined, body: unknown, model: string): number | undefined {
  if (!isRecord(body)) return undefined;
  if (kind === 'tabbyapi') return isRecord(body.parameters) ? windowOf(body.parameters.max_seq_len) : undefined;
  const listed = Array.isArray(body.data) ? body.data.filter(isRecord) : [];
  const named = listed.find((entry) => entry.id === model);
  if (named) return listedWindow(named);
  return kind === 'vllm' && listed.length === 1 ? listedWindow(listed[0]!) : undefined;
}

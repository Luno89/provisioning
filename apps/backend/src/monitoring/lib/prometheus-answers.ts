import { at, isRecord, listAt } from '../../platform/lib/json-shapes.js';
import type { PromAlert } from './monitoring-alerts.js';

export interface PromSample {
  metric: Record<string, string>;
  value: number;
}

const labelsOf = (value: unknown, what: string): Record<string, string> => {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error(`Prometheus answered ${what} that is not a set of labels`);
  return Object.fromEntries(Object.entries(value).map(([key, label]) => [key, String(label)]));
};

const pointOf = (value: unknown): [number, number] => {
  if (!Array.isArray(value) || value.length < 2) throw new Error('Prometheus answered a sample that is not a time and a value');
  return [Number(value[0]), Number(value[1])];
};

export function promAnswer(ok: boolean, status: number, body: unknown): unknown {
  if (!ok || at(body, 'status') !== 'success') {
    const error = at(body, 'error');
    throw new Error(`Prometheus answered ${status}${typeof error === 'string' && error ? `: ${error}` : ''}`);
  }
  return at(body, 'data');
}

export const instantSamples = (data: unknown): PromSample[] =>
  listAt(data, 'result').map((entry) => ({ metric: labelsOf(at(entry, 'metric'), 'a series'), value: pointOf(at(entry, 'value'))[1] }));

export const firstRange = (data: unknown): Array<[number, number]> => {
  const [first] = listAt(data, 'result');
  return listAt(first, 'values').map(pointOf).filter(([, value]) => Number.isFinite(value));
};

export const promAlerts = (data: unknown): PromAlert[] =>
  listAt(data, 'alerts').map((alert) => {
    const annotations = at(alert, 'annotations');
    const activeAt = at(alert, 'activeAt');
    const value = at(alert, 'value');
    return {
      labels: labelsOf(at(alert, 'labels'), 'an alert'),
      ...(annotations !== undefined ? { annotations: labelsOf(annotations, 'an alert\'s annotations') } : {}),
      state: String(at(alert, 'state') ?? ''),
      ...(typeof activeAt === 'string' ? { activeAt } : {}),
      ...(typeof value === 'string' ? { value } : {}),
    };
  });

export const answeredSamples = (answer: unknown): PromSample[] =>
  listAt(answer, 'samples').map((entry) => ({ metric: labelsOf(at(entry, 'metric'), 'a series'), value: Number(at(entry, 'value')) }));

export const answeredPoints = (answer: unknown): Array<[number, number]> => listAt(answer, 'points').map(pointOf);

export const answeredHistory = (answer: unknown): { days: number; kept?: number } => {
  const days = at(answer, 'days');
  const kept = at(answer, 'kept');
  if (typeof days !== 'number') throw new Error('root answered how long history is kept without saying how many days');
  return { days, ...(typeof kept === 'number' ? { kept } : {}) };
};

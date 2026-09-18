import type { SamplingConfig } from '@koala/harness-types';

export const MIN_TEMPERATURE = 0;
export const MAX_TEMPERATURE = 2;
export const MIN_REPLY_TOKENS = 256;
export const MAX_REPLY_TOKENS = 32_000;

export const samplingAt = (temperature: number): SamplingConfig => ({
  toolTurn: { temperature },
  conversation: { temperature },
});

export function temperatureProblem(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || Number.isNaN(value) || value < MIN_TEMPERATURE || value > MAX_TEMPERATURE) {
    return `temperature has to be a number between ${MIN_TEMPERATURE} and ${MAX_TEMPERATURE}`;
  }
  return undefined;
}

export function replyTokensProblem(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < MIN_REPLY_TOKENS || value > MAX_REPLY_TOKENS) {
    return `reply tokens has to be a whole number between ${MIN_REPLY_TOKENS} and ${MAX_REPLY_TOKENS}`;
  }
  return undefined;
}

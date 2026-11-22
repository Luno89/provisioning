import { setUpAgainPath } from './instance-setup.js';

export const MY_KOALA_PATH = '/api/instances/mine';

export type KoalaReadiness =
  | { state: 'ready'; line: string }
  | { state: 'failed'; line: string; detail: string; attempt?: string; again?: string }
  | { state: 'not yet'; line: string };

const NO_KOALA_YET = 'waiting for this computer to put Koala on itself';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const textOf = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value : undefined);

export function koalaReadinessOf(answer: unknown): KoalaReadiness {
  if (!isRecord(answer) || !('instance' in answer) || (answer.instance !== null && !isRecord(answer.instance))) {
    throw new Error(`root's answer about your Koala is not one it gives: ${JSON.stringify(answer)}`);
  }
  const { instance } = answer;
  if (instance === null) return { state: 'not yet', line: `waiting: ${NO_KOALA_YET}` };
  const status = textOf(instance.status) ?? 'waiting';
  if (status === 'ready') return { state: 'ready', line: `ready: ${textOf(instance.detail) ?? 'root gave no detail'}` };
  if (status === 'failed') {
    const detail = textOf(instance.detail) ?? 'root gave no reason';
    const id = textOf(instance.id);
    const may = Array.isArray(answer.can) && answer.can.includes('set-up-again');
    const attempt = textOf(instance.attempt);
    return { state: 'failed', line: `failed: ${detail}`, detail, ...(attempt ? { attempt } : {}), ...(id && may && instance.setupAgain === 'stopped' ? { again: setUpAgainPath(id) } : {}) };
  }
  return { state: 'not yet', line: `${status}: ${textOf(instance.detail) ?? 'root gave no detail'}` };
}

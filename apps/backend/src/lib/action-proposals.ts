import type { ActionKind, ActionProposal } from '@koala/harness-types';

export type { ActionKind, ActionProposal, ActionStatus } from '@koala/harness-types';

export const DECIDABLE: readonly ActionProposal['status'][] = ['proposed', 'failed'];

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function parseEnv(text: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of (text ?? '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const at = line.indexOf('=');
    if (at > 0) out.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  return out;
}

export const renderEnv = (env: ReadonlyMap<string, string>): string =>
  [...env.entries()].map(([key, value]) => `${key}=${value}`).join('\n');

export function envChanges(
  current: string | undefined,
  incoming: Record<string, unknown>,
): { merged: string; changed: string[] } | { problem: string } {
  const entries = Object.entries(incoming);
  if (entries.length === 0) return { problem: 'send at least one KEY: value' };
  const env = parseEnv(current);
  const changed: string[] = [];
  for (const [key, value] of entries) {
    if (!ENV_NAME.test(key)) return { problem: `"${key}" is not an environment variable name` };
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      return { problem: `the value of ${key} has to be text` };
    }
    const text = String(value).replace(/\n/g, ' ').trim();
    const before = env.get(key);
    if (before === text) continue;
    changed.push(before === undefined ? `${key}=${text} (new)` : `${key}: ${before} → ${text}`);
    env.set(key, text);
  }
  if (changed.length === 0) return { problem: 'those values are already set, so there is nothing to change' };
  return { merged: renderEnv(env), changed };
}

export const sameAction = (a: Pick<ActionProposal, 'kind' | 'params'>, kind: ActionKind, params: Record<string, string>): boolean =>
  a.kind === kind && JSON.stringify(a.params) === JSON.stringify(params);

export const pickStrategy = (strategies: readonly string[] | undefined): 'native' | 'helm' =>
  !strategies || strategies.length === 0 || strategies.includes('native') ? 'native' : 'helm';

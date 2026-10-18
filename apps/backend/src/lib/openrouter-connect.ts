import crypto from 'node:crypto';
import { decryptValue, encryptValue, type SecretKey } from './crypto.js';

export const OPENROUTER_AUTH_URL = 'https://openrouter.ai/auth';
export const OPENROUTER_KEYS_URL = 'https://openrouter.ai/api/v1/auth/keys';
export const CONNECT_COOKIE = 'openrouter_connect';
export const CONNECT_PATH = '/api/credentials/llm/openrouter';
export const CONNECT_COOKIE_MS = 15 * 60 * 1000;
export const KEY_LABEL = 'Koala';

export interface PendingConnect {
  userId: string;
  state: string;
  verifier: string;
}

const base64url = (bytes: Buffer): string => bytes.toString('base64url');

export const newPending = (userId: string): PendingConnect => ({
  userId,
  state: base64url(crypto.randomBytes(24)),
  verifier: base64url(crypto.randomBytes(48)),
});

export const challengeOf = (verifier: string): string =>
  base64url(crypto.createHash('sha256').update(verifier).digest());

export function authUrl(pending: PendingConnect, callbackUrl: string): string {
  const params = new URLSearchParams({
    callback_url: callbackUrl,
    code_challenge: challengeOf(pending.verifier),
    code_challenge_method: 'S256',
    state: pending.state,
    key_label: KEY_LABEL,
  });
  return `${OPENROUTER_AUTH_URL}?${params.toString()}`;
}

export const sealPending = (pending: PendingConnect, key: SecretKey): string =>
  Buffer.from(encryptValue(JSON.stringify(pending), key), 'utf8').toString('base64url');

export function openPending(sealed: string | undefined, key: SecretKey): PendingConnect | undefined {
  if (!sealed) return undefined;
  try {
    const value = JSON.parse(decryptValue(Buffer.from(sealed, 'base64url').toString('utf8'), key)) as Partial<PendingConnect>;
    if (typeof value.userId !== 'string' || typeof value.state !== 'string' || typeof value.verifier !== 'string') return undefined;
    return { userId: value.userId, state: value.state, verifier: value.verifier };
  } catch {
    return undefined;
  }
}

export interface CallbackQuery {
  code?: unknown;
  state?: unknown;
  error?: unknown;
}

export type CallbackCheck =
  | { ok: true; code: string; verifier: string }
  | { ok: false; problem: string };

export function checkCallback(query: CallbackQuery, pending: PendingConnect | undefined, userId: string): CallbackCheck {
  if (typeof query.code !== 'string' || !query.code) {
    return { ok: false, problem: 'OpenRouter did not give Koala a key. Nothing was connected.' };
  }
  if (!pending) return { ok: false, problem: 'This connection was not started from Koala, or took too long. Start it again from Models.' };
  if (pending.userId !== userId) return { ok: false, problem: 'This connection was started by someone else signed in on this browser. Start it again from Models.' };
  if (query.state !== pending.state) return { ok: false, problem: 'This connection does not match the one Koala started. Start it again from Models.' };
  return { ok: true, code: query.code, verifier: pending.verifier };
}

export function exchangeBody(code: string, verifier: string): string {
  return JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' });
}

export function exchangeProblem(status: number, text: string): string {
  if (status === 403 && /expired/i.test(text)) return 'OpenRouter says the connection took longer than its ten minutes. Start it again from Models.';
  if (status === 403 || /invalid code/i.test(text)) return 'OpenRouter did not accept the connection. Make sure you are signed in to OpenRouter and start it again from Models.';
  return `OpenRouter answered ${status}${text ? `: ${text.slice(0, 200)}` : ''}`;
}

export const keyFrom = (body: unknown): string | undefined => {
  const key = (body as { key?: unknown } | null)?.key;
  return typeof key === 'string' && key ? key : undefined;
};

export const connectedRedirect = (appUrl: string): string => `${appUrl}/?openrouterConnected=1#/studio/models`;

export const failedRedirect = (appUrl: string, problem: string): string =>
  `${appUrl}/?openrouterError=${encodeURIComponent(problem)}#/studio/models`;

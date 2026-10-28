import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readEnvFile } from '../../apps/backend/src/instances/lib/dev-split.js';
import { fetchSide, handOff, sessionFrom, type Handoff } from './handoff.js';

const ENV_DIR = fileURLToPath(new URL('../../apps/backend/data/dev-split/', import.meta.url));

export interface Answer { status: number; location: string | null; cookie: string | undefined; cookies: string[]; body: unknown }

export async function call(url: string, init: RequestInit & { cookie?: string | undefined } = {}): Promise<Answer> {
  const { cookie, headers, ...rest } = init;
  const response = await fetch(url, {
    redirect: 'manual',
    ...rest,
    headers: { ...(headers as Record<string, string> | undefined), ...(cookie ? { Cookie: cookie } : {}), ...(rest.body ? { 'Content-Type': 'application/json' } : {}) },
  });
  const cookies = response.headers.getSetCookie();
  const set = cookies.map((line) => line.split(';')[0]!).find((pair) => pair.startsWith('session='));
  const text = await response.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, location: response.headers.get('location'), cookie: set, cookies, body };
}

export async function devSplitEnv(): Promise<{ root: Record<string, string>; instance: Record<string, string> }> {
  return {
    root: readEnvFile(await readFile(`${ENV_DIR}root.env`, 'utf8')),
    instance: readEnvFile(await readFile(`${ENV_DIR}instance.env`, 'utf8')),
  };
}

export async function signInAtRoot(rootUrl: string): Promise<string> {
  const google = await call(`${rootUrl}/api/auth/google`);
  assert.equal(google.status, 302, JSON.stringify(google.body));
  const callback = await call(google.location!.startsWith('http') ? google.location! : `${rootUrl}${google.location}`);
  assert.equal(callback.status, 302, JSON.stringify(callback.body));
  assert.ok(callback.cookie, 'root set no session');
  return callback.cookie;
}

export async function signInAtInstance(rootUrl: string, atRoot: string, instanceUrl: string): Promise<Handoff & { session: string | undefined }> {
  const handed = await handOff(fetchSide(rootUrl, atRoot), fetchSide(instanceUrl));
  return { ...handed, session: sessionFrom(handed.exchange.setCookies) };
}

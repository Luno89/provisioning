import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createDatabase, type Database } from '../../apps/backend/src/platform/lib/db-interface.js';
import { DEV } from '../../apps/backend/src/instances/lib/dev-root.js';
import { fetchSide, handOff, sessionFrom } from './handoff.js';
import { devFile } from './dev-temporal.js';

export const DEV_KUBECONFIG = '/etc/rancher/k3s/k3s.yaml';
export const DEV_NAMESPACE = 'nowrinkles';
export const DEV_RELEASE = 'instance';

export const devRootApi = `http://localhost:${DEV.rootApiPort}`;
export const devKoalaApi = `http://127.0.0.1:${DEV.instanceNodePort}`;

const kubectl = (...args: string[]): string =>
  execFileSync('k3s', ['kubectl', '--kubeconfig', DEV_KUBECONFIG, '-n', DEV_NAMESPACE, ...args], { encoding: 'utf8' }).trim();

export function devKoalaCheckout(): string {
  return kubectl('get', 'deployment', `${DEV_RELEASE}-backend`, '-o', 'jsonpath={.spec.template.spec.volumes[?(@.name=="source")].hostPath.path}');
}

export interface DevOwner {
  id: string;
  email: string;
  cookie: string;
}

export async function devOwner(): Promise<DevOwner> {
  const saved = JSON.parse(readFileSync(devFile('apps/backend/data/dev/owner.json'), 'utf8')) as { email: string; password: string };
  const rootIn = await fetchSide(devRootApi)('/api/auth/login', { method: 'POST', body: saved });
  assert.equal(rootIn.status, 200, `dev's owner could not sign in at root: ${rootIn.status} ${rootIn.body.slice(0, 200)}`);
  const rootCookie = sessionFrom(rootIn.setCookies);
  assert.ok(rootCookie, 'signing in at root set no session cookie');
  const handed = await handOff(fetchSide(devRootApi, rootCookie), fetchSide(devKoalaApi));
  const cookie = sessionFrom(handed.exchange.setCookies);
  assert.ok(cookie, `dev's Koala gave its owner no session: ${handed.exchange.status} ${handed.exchange.body.slice(0, 200)}`);
  const me = await fetchSide(devKoalaApi, cookie)('/api/auth/me');
  assert.equal(me.status, 200, `dev's Koala did not take its owner's session: ${me.status}`);
  const { id, email } = JSON.parse(me.body) as { id: string; email: string };
  return { id, email, cookie };
}

function secretOf(name: string): Record<string, string> {
  const data = JSON.parse(kubectl('get', 'secret', name, '-o', 'jsonpath={.data}')) as Record<string, string>;
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [key, Buffer.from(value, 'base64').toString('utf8')]));
}

export function devKoalaDatabase(): Database {
  const keys = secretOf(`${DEV_RELEASE}-keys`);
  const address = kubectl('get', 'service', `${DEV_RELEASE}-mongo`, '-o', 'jsonpath={.spec.clusterIP}');
  const used = kubectl('get', 'deployment', `${DEV_RELEASE}-backend`, '-o', 'jsonpath={.spec.template.spec.containers[0].env[?(@.name=="MONGO_URI")].value}');
  const database = new URL(used.replace(/^mongodb:/, 'http:')).pathname.slice(1);
  assert.ok(database, 'dev\'s Koala names no database in its MONGO_URI');
  return createDatabase({
    ...keys,
    MONGO_URI: `mongodb://admin:${encodeURIComponent(keys.MONGO_ROOT_PASSWORD!)}@${address}:27017/${database}?authSource=admin&directConnection=true`,
  });
}

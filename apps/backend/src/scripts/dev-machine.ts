import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { childEnv, passedOn, PERSON_SESSION } from '@koala/engine-core/child-env';
import { ignore } from '@koala/engine-core/failures';
import { DEV, devKoalaValues, koalaReadinessOf, MY_KOALA_PATH, readEnvFile } from '../instances/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const CHECKOUT = resolve(here, '../../../..');
const DATA = resolve(here, '../../data/dev');
const ROOT_API = `http://localhost:${DEV.rootApiPort}`;
const CONFIG = join(process.env.XDG_CONFIG_HOME || join(os.homedir(), '.config'), 'koala');
const say = (line: string) => console.log(`  ${line}`);
const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
const SERVICE = join(process.env.XDG_CONFIG_HOME || join(os.homedir(), '.config'), 'systemd', 'user', 'koala-machine.service');
const joinedHere = async (rootUrl: string): Promise<boolean> => {
  const config = await readFile(join(CONFIG, 'machine.json'), 'utf8').then((text) => JSON.parse(text) as { rootUrl?: unknown }).catch(ignore('a computer with no machine file has not joined yet'));
  const serviceInstalled = (await access(SERVICE).then(() => true).catch(ignore('a computer whose join stopped before its service was installed has not finished joining'))) ?? false;
  return config?.rootUrl === rootUrl && serviceInstalled;
};
const urlsOfDev = async (): Promise<Record<string, string> | undefined> => readFile(join(DATA, 'urls.env'), 'utf8').then(readEnvFile).catch(ignore('a dev stack with no urls written yet has not started, so nothing joined it'));

export interface RootAsked {
  rootApi: string;
  say: (line: string) => void;
  pause: (ms: number) => Promise<void>;
}

async function untilRootAnswers({ rootApi, pause }: RootAsked): Promise<void> {
  for (;;) {
    const ok = (await fetch(`${rootApi}/api/identity/keys`).then((answer) => answer.ok).catch(ignore('while root starts it refuses connections, which is what starting looks like; the loop asks again'))) ?? false;
    if (ok) return;
    await pause(1000);
  }
}

async function owner(setupCode: string): Promise<string> {
  const file = join(DATA, 'owner.json');
  const post = (path: string, body: unknown) => fetch(`${ROOT_API}/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let saved = await readFile(file, 'utf8').then((text) => JSON.parse(text) as { email: string; password: string }).catch(ignore('with no owner kept yet, dev makes one'));
  if (!saved) {
    saved = { email: DEV.ownerEmail, password: crypto.randomBytes(18).toString('base64url') };
    const made = await post('/auth/register', { email: saved.email, password: saved.password, inviteCode: setupCode });
    if (!made.ok) throw new Error(`the dev owner could not sign up on root: ${made.status} ${await made.text()}`);
    await writeFile(file, JSON.stringify(saved), { mode: 0o600 });
    say(`you are ${saved.email} on root; the password is in ${file}`);
  }
  const signedIn = await post('/auth/login', saved);
  if (!signedIn.ok) throw new Error(`the dev owner could not sign in on root: ${signedIn.status} ${await signedIn.text()}`);
  const cookie = signedIn.headers.getSetCookie().map((line) => line.split(';')[0]!).find((pair) => /^(__Host-)?session=/.test(pair));
  if (!cookie) throw new Error('signing in on root set no session cookie');
  return cookie;
}

async function joinThisComputer(cookie: string, instanceWeb: string): Promise<void> {
  await mkdir(CONFIG, { recursive: true });
  await writeFile(join(CONFIG, 'koala-values.yaml'), devKoalaValues(CHECKOUT, instanceWeb));
  const made = await fetch(`${ROOT_API}/api/my-machines/join-code`, { method: 'POST', headers: { 'content-type': 'application/json', Cookie: cookie }, body: JSON.stringify({ koalaName: DEV.instanceName }) });
  if (!made.ok) throw new Error(`root gave no machine command: ${made.status} ${await made.text()}`);
  const { command } = await made.json() as { command: string };
  say('this computer joins your account as a machine, as anyone\'s does; it asks for sudo for Tailscale and k3s');
  const code = await new Promise<number>((done) => spawn('sh', ['-c', `${command} --folder "${join(os.homedir(), 'koala')}"`], { stdio: 'inherit', env: childEnv(passedOn(PERSON_SESSION)) }).on('exit', (exit) => done(exit ?? 1)));
  if (code !== 0) throw new Error(`the machine command stopped (${code})`);
}

export async function untilKoalaReady(cookie: string, asked: RootAsked): Promise<void> {
  const { rootApi, say, pause } = asked;
  let told = '';
  for (;;) {
    const answer = await fetch(`${rootApi}${MY_KOALA_PATH}`, { headers: { Cookie: cookie } }).catch(ignore('root refusing connections is root restarting under its watcher; the loop waits for it to answer again'));
    if (!answer) {
      say('root stopped answering (its watcher restarts it when its code changes); waiting for it');
      await untilRootAnswers(asked);
      continue;
    }
    const koala = koalaReadinessOf(await answer.json());
    if (koala.line !== told) say(`your Koala is ${koala.line}`);
    told = koala.line;
    if (koala.state === 'ready') return;
    if (koala.state === 'failed') throw new Error(`putting Koala on this computer failed: ${koala.detail}`);
    await pause(2000);
  }
}

const DEV_ROOT: RootAsked = { rootApi: ROOT_API, say, pause };

async function main(): Promise<void> {
  const root = readEnvFile(await readFile(join(DATA, 'root.env'), 'utf8'));
  const urls = readEnvFile(await readFile(join(DATA, 'urls.env'), 'utf8'));
  await untilRootAnswers(DEV_ROOT);
  const cookie = await owner(root.ADMIN_SETUP_CODE!);
  if (!await joinedHere(urls.ROOT_WEB!)) await joinThisComputer(cookie, urls.INSTANCE_WEB!);
  await untilKoalaReady(cookie, DEV_ROOT);
  say(`your Koala runs on this computer: ${urls.INSTANCE_WEB}`);
  process.exit(0);
}

async function joinedAlready(): Promise<void> {
  const urls = await urlsOfDev();
  process.exit(urls?.ROOT_WEB && await joinedHere(urls.ROOT_WEB) ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  (process.argv[2] === 'joined' ? joinedAlready() : main()).catch((err) => {
    console.error(`dev: ${(err as Error).message}`);
    process.exit(1);
  });
}

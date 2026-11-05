import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ignore } from '@koala/engine-core/failures';
import { DEV, devKoalaValues, readEnvFile } from '../instances/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const CHECKOUT = resolve(here, '../../../..');
const DATA = resolve(here, '../../data/dev');
const ROOT_API = `http://localhost:${DEV.rootApiPort}`;
const CONFIG = join(process.env.XDG_CONFIG_HOME || join(os.homedir(), '.config'), 'koala');
const say = (line: string) => console.log(`  ${line}`);
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
const joinedHere = async (rootUrl: string): Promise<boolean> => {
  const config = await readFile(join(CONFIG, 'machine.json'), 'utf8').then((text) => JSON.parse(text) as { rootUrl?: unknown }).catch(ignore('a computer with no machine file has not joined yet'));
  return config?.rootUrl === rootUrl;
};

async function untilRootAnswers(): Promise<void> {
  for (;;) {
    const ok = (await fetch(`${ROOT_API}/api/identity/keys`).then((answer) => answer.ok).catch(ignore('while root starts it refuses connections, which is what starting looks like; the loop asks again'))) ?? false;
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
  const code = await new Promise<number>((done) => spawn('sh', ['-c', `${command} --folder "${join(os.homedir(), 'koala')}"`], { stdio: 'inherit' }).on('exit', (exit) => done(exit ?? 1)));
  if (code !== 0) throw new Error(`the machine command stopped (${code})`);
}

async function untilKoalaReady(cookie: string): Promise<void> {
  let told = '';
  for (;;) {
    const { instance } = await (await fetch(`${ROOT_API}/api/instances/mine`, { headers: { Cookie: cookie } })).json() as { instance: { status?: string; detail?: string } | null };
    const line = `${instance?.status ?? 'waiting'}: ${instance?.detail ?? 'waiting for this computer to put Koala on itself'}`;
    if (line !== told) say(`your Koala is ${line}`);
    told = line;
    if (instance?.status === 'ready') return;
    if (instance?.status === 'failed') throw new Error(`putting Koala on this computer failed: ${instance.detail ?? ''}`);
    await pause(2000);
  }
}

async function main(): Promise<void> {
  const root = readEnvFile(await readFile(join(DATA, 'root.env'), 'utf8'));
  const urls = readEnvFile(await readFile(join(DATA, 'urls.env'), 'utf8'));
  await untilRootAnswers();
  const cookie = await owner(root.ADMIN_SETUP_CODE!);
  if (!await joinedHere(urls.ROOT_WEB!)) await joinThisComputer(cookie, urls.INSTANCE_WEB!);
  await untilKoalaReady(cookie);
  say(`your Koala runs on this computer: ${urls.INSTANCE_WEB}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`dev: ${(err as Error).message}`);
  process.exit(1);
});

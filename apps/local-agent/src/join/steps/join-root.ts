import type { Progress, Step } from '@koala/provision';
import { machineClientOf, newClientKey } from '@koala/engine-core/root-client';
import { configFile } from '../../machine-config.js';
import { configHome, joinedOf, type Joined, type JoinContext } from '../context.js';

const machineFile = (ctx: JoinContext): string => configFile({ ...ctx.host.env, XDG_CONFIG_HOME: configHome(ctx) });

const savedToken = async (ctx: JoinContext): Promise<string | undefined> => {
  const file = machineFile(ctx);
  const raw = await ctx.host.readOwn(file).catch((err: Error) => {
    throw new Error(`${err.message}. Make it yours and readable only by you (chown ${ctx.host.user} ${file}; chmod 600 ${file}), then run this command again.`, { cause: err });
  });
  if (raw === undefined) return undefined;
  const notKoalas = (why: string): Error => new Error(`${file} is not the settings Koala writes (${why}), so Koala cannot tell which machine this is. If this machine is on My Machines already, remove it there; then delete ${file} and run this command again.`);
  let saved: unknown;
  try {
    saved = JSON.parse(raw);
  } catch (err) {
    throw notKoalas((err as Error).message);
  }
  const token = (saved as { token?: unknown } | null)?.token;
  if (typeof token !== 'string' || !token) throw notKoalas('it names no device token');
  return token;
};

const settingsOf = (joined: Joined, agentsNotSetUp?: string): string =>
  `${JSON.stringify({ rootUrl: joined.rootUrl, token: joined.token, deviceId: joined.deviceId, rootDir: joined.rootDir, key: joined.key, ...(agentsNotSetUp ? { agentsNotSetUp } : {}) }, null, 2)}\n`;

export const keepAgentsNotSetUp = (ctx: JoinContext, why: string): Promise<void> => ctx.host.writeOwn(machineFile(ctx), settingsOf(joinedOf(ctx), why), 0o600);

const text = (env: Record<string, unknown> | undefined, name: string): string => (typeof env?.[name] === 'string' ? env[name] : '');

function joinedFrom(raw: unknown, key: string): Joined {
  const env = (raw as { env?: Record<string, unknown> } | undefined)?.env;
  const joined: Joined = {
    rootUrl: text(env, 'KOALA_ROOT_URL'),
    deviceId: text(env, 'KOALA_DEVICE_ID'),
    token: text(env, 'KOALA_DEVICE_TOKEN'),
    registrationCode: text(env, 'KOALA_REGISTRATION_TOKEN'),
    key,
    rootDir: text(env, 'KOALA_ROOT_DIR'),
    meshLoginServer: text(env, 'MESH_LOGIN_SERVER'),
    meshAuthKey: text(env, 'MESH_AUTH_KEY'),
    registry: text(env, 'KOALA_REGISTRY'),
  };
  const absent = (['rootUrl', 'deviceId', 'token', 'registrationCode', 'rootDir'] as const).filter((name) => !joined[name]);
  if (absent.length > 0) throw new Error(`Koala's answer to the join named no ${absent.join(', ')}`);
  if (!joined.meshLoginServer || !joined.meshAuthKey) throw new Error('Koala\'s root named no private network for this machine, and a machine takes work only over it');
  return joined;
}

async function join(ctx: JoinContext, progress: Progress): Promise<void> {
  const saved = await savedToken(ctx);
  const body = { code: ctx.args.code, hostname: ctx.host.hostname, rootDir: ctx.folder, os: ctx.host.os, replaces: saved ?? '' };
  let response: Response;
  try {
    response = await ctx.host.fetch(`${ctx.args.url}/api/machines/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch (err) {
    const cause = (err as Error).cause instanceof Error ? ` (${((err as Error).cause as Error).message})` : '';
    throw new Error(`${ctx.args.url} could not be reached: ${(err as Error).message}${cause}`, { cause: err });
  }
  if (response.status !== 200) throw new Error(`Koala refused this machine (${response.status}): ${(await response.text()).trim()}`);
  const joined = joinedFrom(await response.json(), newClientKey());
  const file = machineFile(ctx);
  await ctx.host.writeOwn(file, settingsOf(joined), 0o600);
  await machineClientOf({ rootUrl: joined.rootUrl, deviceId: joined.deviceId, key: joined.key, registrationCode: joined.registrationCode, reach: ctx.host.fetch }).register();
  ctx.joined = joined;
  progress.line(`this machine is ${ctx.host.hostname} on your account`);
  progress.line(`its settings are in ${file}, readable only by you`);
}

export const joinRootStep = (url: string): Step<JoinContext> => ({
  id: 'join',
  title: `Joining ${url}`,
  check: async (ctx) => {
    if (!ctx.joined) return { done: false, why: 'this machine has not joined in this run: each run joins with its own code' };
    return await savedToken(ctx) === ctx.joined.token ? { done: true } : { done: false, why: `${machineFile(ctx)} does not hold the token Koala just gave this machine` };
  },
  apply: join,
});

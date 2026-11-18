import type { Progress, Step } from '@koala/provision';
import { configFile } from '../../machine-config.js';
import { configHome, type Joined, type JoinContext } from '../context.js';

const machineFile = (ctx: JoinContext): string => configFile({ ...ctx.host.env, XDG_CONFIG_HOME: configHome(ctx) });

const savedToken = async (ctx: JoinContext): Promise<{ token?: string; unreadable?: string }> => {
  const file = machineFile(ctx);
  const raw = await ctx.host.readOwn(file);
  if (raw === undefined) return {};
  try {
    const token = (JSON.parse(raw) as { token?: unknown }).token;
    return typeof token === 'string' && token ? { token } : {};
  } catch (err) {
    return { unreadable: `${file} is not the settings Koala writes (${(err as Error).message})` };
  }
};

const text = (env: Record<string, unknown> | undefined, name: string): string => (typeof env?.[name] === 'string' ? env[name] : '');

function joinedFrom(raw: unknown): Joined {
  const env = (raw as { env?: Record<string, unknown> } | undefined)?.env;
  const joined: Joined = {
    rootUrl: text(env, 'KOALA_ROOT_URL'),
    deviceId: text(env, 'KOALA_DEVICE_ID'),
    token: text(env, 'KOALA_DEVICE_TOKEN'),
    rootDir: text(env, 'KOALA_ROOT_DIR'),
    meshLoginServer: text(env, 'MESH_LOGIN_SERVER'),
    meshAuthKey: text(env, 'MESH_AUTH_KEY'),
    registry: text(env, 'KOALA_REGISTRY'),
  };
  const absent = (['rootUrl', 'deviceId', 'token', 'rootDir'] as const).filter((name) => !joined[name]);
  if (absent.length > 0) throw new Error(`Koala's answer to the join named no ${absent.join(', ')}`);
  if (!joined.meshLoginServer || !joined.meshAuthKey) throw new Error('Koala\'s root named no private network for this machine, and a machine takes work only over it');
  return joined;
}

async function join(ctx: JoinContext, progress: Progress): Promise<void> {
  const saved = await savedToken(ctx);
  if (saved.unreadable) progress.line(`${saved.unreadable}, so this joins as a new machine`);
  const body = { code: ctx.args.code, hostname: ctx.host.hostname, rootDir: ctx.folder, os: ctx.host.os, replaces: saved.token ?? '' };
  let response: Response;
  try {
    response = await ctx.host.fetch(`${ctx.args.url}/api/machines/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch (err) {
    const cause = (err as Error).cause instanceof Error ? ` (${((err as Error).cause as Error).message})` : '';
    throw new Error(`${ctx.args.url} could not be reached: ${(err as Error).message}${cause}`, { cause: err });
  }
  if (response.status !== 200) throw new Error(`Koala refused this machine (${response.status}): ${(await response.text()).trim()}`);
  const joined = joinedFrom(await response.json());
  const file = machineFile(ctx);
  await ctx.host.writeOwn(file, `${JSON.stringify({ rootUrl: joined.rootUrl, token: joined.token, deviceId: joined.deviceId, rootDir: joined.rootDir }, null, 2)}\n`, 0o600);
  ctx.joined = joined;
  progress.line(`this machine is ${ctx.host.hostname} on your account`);
  progress.line(`its settings are in ${file}, readable only by you`);
}

export const joinRootStep = (url: string): Step<JoinContext> => ({
  id: 'join',
  title: `Joining ${url}`,
  check: async (ctx) => {
    if (!ctx.joined) return { done: false, why: 'this machine has not joined in this run: each run joins with its own code' };
    const saved = await savedToken(ctx);
    return saved.token === ctx.joined.token ? { done: true } : { done: false, why: `${machineFile(ctx)} does not hold the token Koala just gave this machine` };
  },
  apply: join,
});

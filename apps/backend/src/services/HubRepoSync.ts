import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const run = promisify(execFile);

export interface GitEnd {
  url: string;
  auth?: { username: string; token: string } | undefined;
}

export type MainSync =
  | { outcome: 'same'; head: string | undefined }
  | { outcome: 'to-hub' | 'from-hub' | 'merged'; head: string }
  | { outcome: 'conflict'; files: string[]; kept: string };

const BOT = ['-c', 'user.name=Koala', '-c', 'user.email=koala@localhost'];

function envFor(ends: readonly GitEnd[]): NodeJS.ProcessEnv {
  const authed = ends.filter((end) => end.auth);
  const config: Record<string, string> = {
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: String(authed.length + 2),
    GIT_CONFIG_KEY_0: 'maintenance.auto',
    GIT_CONFIG_VALUE_0: 'false',
    GIT_CONFIG_KEY_1: 'gc.auto',
    GIT_CONFIG_VALUE_1: '0',
  };
  authed.forEach((end, index) => {
    config[`GIT_CONFIG_KEY_${index + 2}`] = `http.${end.url}.extraHeader`;
    config[`GIT_CONFIG_VALUE_${index + 2}`] = `Authorization: Basic ${Buffer.from(`${end.auth!.username}:${end.auth!.token}`).toString('base64')}`;
  });
  return { ...process.env, ...config };
}

const masked = (text: string, ends: readonly GitEnd[]): string => ends.reduce((said, end) => (end.auth ? said.replaceAll(end.auth.token, '***') : said), text);

async function headOf(end: GitEnd, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const listed = (await run('git', ['ls-remote', end.url, 'refs/heads/main'], { env })).stdout.trim();
  return listed ? listed.split(/\s+/)[0] : undefined;
}

export async function mainHeads(owner: GitEnd, hub: GitEnd): Promise<{ owner: string | undefined; hub: string | undefined }> {
  const env = envFor([owner, hub]);
  return { owner: await headOf(owner, env), hub: await headOf(hub, env) };
}

export async function syncMain(owner: GitEnd, hub: GitEnd, keptName: () => string): Promise<MainSync> {
  const ends = [owner, hub];
  const env = envFor(ends);
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'koala-hub-sync-'));
  const work = path.join(scratch, 'work');
  const git = (...args: string[]) => run('git', ['-C', work, ...BOT, ...args], { env, maxBuffer: 64 * 1024 * 1024 });
  try {
    await run('git', ['init', '--quiet', work], { env });
    await git('remote', 'add', 'owner', owner.url);
    await git('remote', 'add', 'hub', hub.url);
    const [ownerHead, hubHead] = [await headOf(owner, env), await headOf(hub, env)];
    if (ownerHead) await git('fetch', '--quiet', 'owner', '+refs/heads/main:refs/remotes/owner/main');
    if (hubHead) await git('fetch', '--quiet', 'hub', '+refs/heads/main:refs/remotes/hub/main');
    if (ownerHead === hubHead) return { outcome: 'same', head: ownerHead };
    if (!hubHead) {
      await git('push', '--quiet', 'hub', 'refs/remotes/owner/main:refs/heads/main');
      return { outcome: 'to-hub', head: ownerHead! };
    }
    if (!ownerHead) {
      await git('push', '--quiet', 'owner', 'refs/remotes/hub/main:refs/heads/main');
      return { outcome: 'from-hub', head: hubHead };
    }
    const contains = async (ancestor: string, of: string) => git('merge-base', '--is-ancestor', ancestor, of).then(() => true, () => false);
    if (await contains(hubHead, ownerHead)) {
      await git('push', '--quiet', 'hub', 'refs/remotes/owner/main:refs/heads/main');
      return { outcome: 'to-hub', head: ownerHead };
    }
    if (await contains(ownerHead, hubHead)) {
      await git('push', '--quiet', 'owner', 'refs/remotes/hub/main:refs/heads/main');
      return { outcome: 'from-hub', head: hubHead };
    }
    await git('checkout', '--quiet', '-b', 'main', 'refs/remotes/owner/main');
    const merged = await git('merge', '--quiet', '--no-edit', '-m', 'Merge the shared project\'s main from the hub', 'refs/remotes/hub/main').then(() => true, () => false);
    if (!merged) {
      const files = (await git('diff', '--name-only', '--diff-filter=U')).stdout.split('\n').map((line) => line.trim()).filter(Boolean);
      const kept = keptName();
      await git('merge', '--abort');
      await git('push', '--quiet', 'owner', `refs/remotes/hub/main:refs/heads/${kept}`);
      return { outcome: 'conflict', files, kept };
    }
    const head = (await git('rev-parse', 'HEAD')).stdout.trim();
    await git('push', '--quiet', 'hub', 'HEAD:refs/heads/main');
    await git('push', '--quiet', 'owner', 'HEAD:refs/heads/main');
    return { outcome: 'merged', head };
  } catch (err) {
    throw new Error(`syncing main with the hub failed: ${masked(((err as { stderr?: string }).stderr || (err as Error).message).trim(), ends)}`);
  } finally {
    await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

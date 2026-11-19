import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { nodeProcesses, unpromptedGit, type ProcessResult, type Processes } from '../../platform/index.js';

class GitFailed extends Error {
  constructor(result: ProcessResult) {
    super(result.stderr.trim() || `git exited ${result.code}`);
    this.name = 'GitFailed';
  }
}

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
  return unpromptedGit({}, {
    'maintenance.auto': 'false',
    'gc.auto': '0',
    ...Object.fromEntries(ends.filter((end) => end.auth).map((end) => [`http.${end.url}.extraHeader`, `Authorization: Basic ${Buffer.from(`${end.auth!.username}:${end.auth!.token}`).toString('base64')}`])),
  });
}

const masked = (text: string, ends: readonly GitEnd[]): string => ends.reduce((said, end) => (end.auth ? said.replaceAll(end.auth.token, '***') : said), text);

async function headOf(end: GitEnd, env: NodeJS.ProcessEnv, processes: Processes): Promise<string | undefined> {
  const result = await processes.run({ command: 'git', args: ['ls-remote', end.url, 'refs/heads/main'], env });
  if (result.code !== 0) throw new GitFailed(result);
  const listed = result.stdout.trim();
  return listed ? listed.split(/\s+/)[0] : undefined;
}

export async function mainHeads(owner: GitEnd, hub: GitEnd, processes: Processes = nodeProcesses): Promise<{ owner: string | undefined; hub: string | undefined }> {
  const env = envFor([owner, hub]);
  return { owner: await headOf(owner, env, processes), hub: await headOf(hub, env, processes) };
}

export async function syncMain(owner: GitEnd, hub: GitEnd, keptName: () => string, processes: Processes = nodeProcesses): Promise<MainSync> {
  const ends = [owner, hub];
  const env = envFor(ends);
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'koala-hub-sync-'));
  const work = path.join(scratch, 'work');
  const attempt = (...args: string[]) => processes.run({ command: 'git', args: ['-C', work, ...BOT, ...args], env });
  const git = async (...args: string[]) => {
    const result = await attempt(...args);
    if (result.code !== 0) throw new GitFailed(result);
    return result;
  };
  try {
    const init = await processes.run({ command: 'git', args: ['init', '--quiet', work], env });
    if (init.code !== 0) throw new GitFailed(init);
    await git('remote', 'add', 'owner', owner.url);
    await git('remote', 'add', 'hub', hub.url);
    const [ownerHead, hubHead] = [await headOf(owner, env, processes), await headOf(hub, env, processes)];
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
    const contains = async (ancestor: string, of: string) => {
      const result = await attempt('merge-base', '--is-ancestor', ancestor, of);
      if (result.code === 0) return true;
      if (result.code === 1) return false;
      throw new GitFailed(result);
    };
    if (await contains(hubHead, ownerHead)) {
      await git('push', '--quiet', 'hub', 'refs/remotes/owner/main:refs/heads/main');
      return { outcome: 'to-hub', head: ownerHead };
    }
    if (await contains(ownerHead, hubHead)) {
      await git('push', '--quiet', 'owner', 'refs/remotes/hub/main:refs/heads/main');
      return { outcome: 'from-hub', head: hubHead };
    }
    await git('checkout', '--quiet', '-b', 'main', 'refs/remotes/owner/main');
    const merge = await attempt('merge', '--quiet', '--no-edit', '-m', 'Merge the shared project\'s main from the hub', 'refs/remotes/hub/main');
    if (merge.code !== 0 && merge.code !== 1) throw new GitFailed(merge);
    if (merge.code === 1) {
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
    throw new Error(`syncing main with the hub failed: ${masked((err as Error).message.trim(), ends)}`);
  } finally {
    await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

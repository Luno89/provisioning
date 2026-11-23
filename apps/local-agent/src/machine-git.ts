import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { nodeProcesses } from '@koala/engine-core/node-processes';
import { ProcessNotStarted, type Named, type ProcessResult, type Processes } from '@koala/engine-core/processes';
import { MACHINE_TREES, type MachineGitOp, type MachineGitResult } from '@koala/engine-core';
import { insideRoot } from './acp-session.js';
import { present } from './file-present.js';


async function textUnlessGone(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

const gitOver = (processes: Processes) => (args: string[], cwd: string, env: Named): Promise<ProcessResult> =>
  processes.run({ command: 'git', args, cwd, env }).catch((err: unknown) => {
    if (err instanceof ProcessNotStarted) return { code: 1, stdout: '', stderr: err.message };
    throw err;
  });

export interface MachineGitOptions {
  rootDir: string;
  backendUrl: string;
  token: string | (() => Promise<string>);
  processes?: Processes | undefined;
  remote?: ((repo: string) => string) | undefined;
}

const SENT = 'refs/koala/sent';
const WORKSPACE_NOW = 'refs/remotes/koala/workspace';
const CONFLICT_MARKER = /^(<{7}|>{7})( |$)/m;
const AS_MACHINE = ['-c', 'user.name=koala-machine', '-c', 'user.email=machine@koala.local'];

export const QUIET_REPOSITORY: Named = {
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'maintenance.auto',
  GIT_CONFIG_VALUE_0: 'false',
  GIT_CONFIG_KEY_1: 'gc.auto',
  GIT_CONFIG_VALUE_1: '0',
};

export const remoteFor =(backendUrl: string, repo: string): string =>
  `${backendUrl.replace(/\/$/, '')}/api/machines/git/${encodeURIComponent(repo)}.git`;

export function createMachineGit(options: MachineGitOptions): (op: MachineGitOp) => Promise<MachineGitResult> {
  const git = gitOver(options.processes ?? nodeProcesses);
  const env: Named = { GIT_TERMINAL_PROMPT: '0', ...QUIET_REPOSITORY };
  return async (op) => {
    const sent = new Set<string>(typeof options.token === 'string' ? [options.token] : []);
    const signedIn = async (): Promise<string[]> => {
      const token = typeof options.token === 'function' ? await options.token() : options.token;
      sent.add(token);
      return ['-c', 'credential.helper=', '-c', 'core.askPass=', '-c', `http.extraHeader=Authorization: Bearer ${token}`];
    };
    const hidden = (text: string): string => [...sent].filter(Boolean).reduce((said, token) => said.replaceAll(token, '***'), text).trim();
    const relative = path.posix.join(MACHINE_TREES, op.folder);
    const folder = insideRoot(options.rootDir, relative);
    if (!folder) return { ok: false, error: `${op.folder} is outside this machine's folder` };
    if (op.kind === 'remove') {
      if (folder === options.rootDir || !relative.startsWith(`${MACHINE_TREES}/`)) return { ok: false, error: `${op.folder} is not a folder Koala made` };
      await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      return { ok: true, path: relative, commit: '' };
    }
    const remote = options.remote?.(op.repo) ?? remoteFor(options.backendUrl, op.repo);
    const answered = async (args: string[], accepted: readonly number[], what: string): Promise<ProcessResult> => {
      const ran = await git(args, folder, env);
      if (!accepted.includes(ran.code)) throw new Error(`${what}: ${hidden(ran.stderr || ran.stdout)}`);
      return ran;
    };
    const must = async (args: string[], what: string): Promise<string> => (await answered(args, [0], what)).stdout.trim();
    const changed = async (what: string): Promise<boolean> => (await answered(['diff', '--cached', '--quiet'], [0, 1], what)).code === 1;

    const unmerged = async (): Promise<string[]> =>
      (await must(['diff', '--name-only', '--diff-filter=U'], 'could not list the files left in conflict')).split('\n').map((line) => line.trim()).filter(Boolean);
    const stillMarked = async (files: string[]): Promise<string[]> => {
      const marked: string[] = [];
      for (const file of files) {
        if (CONFLICT_MARKER.test(await textUnlessGone(path.join(folder, file)))) marked.push(file);
      }
      return marked;
    };
    const markersSince = async (base: string): Promise<string[]> => {
      if (!base) return [];
      const checked = await answered(['diff', '--cached', '--check', base], [0, 2], 'could not check the work for conflict markers');
      return [...new Set(checked.stdout.split('\n').filter((line) => line.includes('leftover conflict marker')).map((line) => line.split(':')[0]!))];
    };

    try {
      if (op.kind === 'checkout') {
        await mkdir(folder, { recursive: true });
        if (!(await present(path.join(folder, '.git')))) {
          await must(['init', '-q', '-b', 'koala-work'], 'could not start the folder');
        }
        await must([...(await signedIn()), 'fetch', '-q', remote, `+refs/heads/${op.branch}:refs/remotes/koala/work`], `could not fetch ${op.branch}`);
        await must(['checkout', '-q', '-f', '-B', 'koala-work', 'refs/remotes/koala/work'], 'could not check it out');
        await must(['clean', '-q', '-fd'], 'could not clear what the last turn left');
        await must(['update-ref', SENT, 'HEAD'], 'could not note what the workspace has');
        return { ok: true, path: relative, commit: await must(['rev-parse', 'HEAD'], 'could not read the commit') };
      }

      if (op.kind === 'merge') {
        await must(['add', '-A'], 'could not stage the work');
        if (await changed('could not tell whether there is work to commit')) {
          await must([...AS_MACHINE, 'commit', '-q', '-m', 'Work so far, before the workspace is merged in'], 'could not commit the work');
        }
        await must([...(await signedIn()), 'fetch', '-q', remote, `+refs/heads/${op.branch}:${WORKSPACE_NOW}`], `could not fetch ${op.branch}`);
        const merged = await git([...AS_MACHINE, 'merge', '-q', '--no-edit', '-m', 'Merge what the workspace has now', WORKSPACE_NOW], folder, env);
        const conflicts = merged.code === 0 ? [] : await unmerged();
        if (merged.code !== 0 && conflicts.length === 0) throw new Error(`could not merge the workspace in: ${hidden(merged.stderr || merged.stdout)}`);
        return { ok: true, path: relative, commit: await must(['rev-parse', 'HEAD'], 'could not read the commit'), conflicts };
      }

      const still = op.keep ? [] : await stillMarked(await unmerged());
      if (still.length) return { ok: false, error: `these files still have conflicts to resolve: ${still.join(', ')}`, unresolved: still };
      await must(['add', '-A'], 'could not stage the work');
      const sent = (await answered(['rev-parse', '--verify', '-q', SENT], [0, 1], 'could not read what the workspace has')).stdout.trim();
      const marked = op.keep ? [] : await markersSince(sent);
      if (marked.length) return { ok: false, error: `these files still hold conflict markers: ${marked.join(', ')}`, unresolved: marked };
      const rewritten = sent !== '' && (await answered(['merge-base', '--is-ancestor', sent, 'HEAD'], [0, 1], 'could not tell whether the work was rewritten')).code === 1;
      if (rewritten) {
        const tree = await must(['write-tree'], 'could not read the work');
        const laid = await must([...AS_MACHINE, 'commit-tree', tree, '-p', sent, '-m', op.message], 'could not lay the work over what the workspace has');
        await must(['reset', '-q', '--soft', laid], 'could not lay the work over what the workspace has');
      } else if (await changed('could not tell whether there is work to commit')) {
        await must([...AS_MACHINE, 'commit', '-q', '-m', op.message], 'could not commit the work');
      }
      await must([...(await signedIn()), 'push', '-q', '--force', remote, `HEAD:refs/heads/${op.branch}`], `could not push ${op.branch}`);
      await must(['update-ref', SENT, 'HEAD'], 'could not note what the workspace has');
      return { ok: true, path: relative, commit: await must(['rev-parse', 'HEAD'], 'could not read the commit') };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  };
}

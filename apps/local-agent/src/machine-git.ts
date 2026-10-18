import { execFile } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { MACHINE_TREES, type MachineGitOp, type MachineGitResult } from '@koala/engine-core';
import { insideRoot } from './acp-session.js';

export interface GitRun {
  (args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }>;
}

const runGit: GitRun = (args, cwd, env) => new Promise((resolve) => {
  execFile('git', args, { cwd, env, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
    const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0;
    resolve({ code, stdout: String(stdout), stderr: String(stderr) });
  });
});

export interface MachineGitOptions {
  rootDir: string;
  backendUrl: string;
  token: string;
  git?: GitRun | undefined;
  remote?: ((repo: string) => string) | undefined;
}

const SENT = 'refs/koala/sent';
const AS_MACHINE = ['-c', 'user.name=koala-machine', '-c', 'user.email=machine@koala.local'];

export const remoteFor =(backendUrl: string, repo: string): string =>
  `${backendUrl.replace(/\/$/, '')}/api/machines/git/${encodeURIComponent(repo)}.git`;

export function createMachineGit(options: MachineGitOptions): (op: MachineGitOp) => Promise<MachineGitResult> {
  const git = options.git ?? runGit;
  const { SSH_ASKPASS: _ssh, GIT_ASKPASS: _git, ...inherited } = process.env;
  const env: NodeJS.ProcessEnv = { ...inherited, GIT_TERMINAL_PROMPT: '0' };
  const signedIn = ['-c', 'credential.helper=', '-c', 'core.askPass=', '-c', `http.extraHeader=Authorization: Bearer ${options.token}`];
  const hidden = (text: string): string => text.replaceAll(options.token, '***').trim();

  return async (op) => {
    const relative = path.posix.join(MACHINE_TREES, op.folder);
    const folder = insideRoot(options.rootDir, relative);
    if (!folder) return { ok: false, error: `${op.folder} is outside this machine's folder` };
    const remote = options.remote?.(op.repo) ?? remoteFor(options.backendUrl, op.repo);
    const must = async (args: string[], what: string): Promise<string> => {
      const ran = await git(args, folder, env);
      if (ran.code !== 0) throw new Error(`${what}: ${hidden(ran.stderr || ran.stdout)}`);
      return ran.stdout.trim();
    };

    try {
      if (op.kind === 'checkout') {
        await mkdir(folder, { recursive: true });
        if (!(await stat(path.join(folder, '.git')).then(() => true, () => false))) {
          await must(['init', '-q', '-b', 'koala-work'], 'could not start the folder');
        }
        await must([...signedIn, 'fetch', '-q', remote, `+refs/heads/${op.branch}:refs/remotes/koala/work`], `could not fetch ${op.branch}`);
        await must(['checkout', '-q', '-f', '-B', 'koala-work', 'refs/remotes/koala/work'], 'could not check it out');
        await must(['clean', '-q', '-fd'], 'could not clear what the last turn left');
        await must(['update-ref', SENT, 'HEAD'], 'could not note what the workspace has');
        return { ok: true, path: relative, commit: await must(['rev-parse', 'HEAD'], 'could not read the commit') };
      }

      await must(['add', '-A'], 'could not stage the work');
      const sent = (await git(['rev-parse', '--verify', '-q', SENT], folder, env)).stdout.trim();
      const rewritten = sent !== '' && (await git(['merge-base', '--is-ancestor', sent, 'HEAD'], folder, env)).code !== 0;
      if (rewritten) {
        const tree = await must(['write-tree'], 'could not read the work');
        const laid = await must([...AS_MACHINE, 'commit-tree', tree, '-p', sent, '-m', op.message], 'could not lay the work over what the workspace has');
        await must(['reset', '-q', '--soft', laid], 'could not lay the work over what the workspace has');
      } else if ((await git(['diff', '--cached', '--quiet'], folder, env)).code !== 0) {
        await must([...AS_MACHINE, 'commit', '-q', '-m', op.message], 'could not commit the work');
      }
      await must([...signedIn, 'push', '-q', '--force', remote, `HEAD:refs/heads/${op.branch}`], `could not push ${op.branch}`);
      await must(['update-ref', SENT, 'HEAD'], 'could not note what the workspace has');
      return { ok: true, path: relative, commit: await must(['rev-parse', 'HEAD'], 'could not read the commit') };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  };
}

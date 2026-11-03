import { nodeProcesses, ProcessFailed, type ProcessResult, type Processes } from '../../platform/index.js';

export type Landing =
  | { outcome: 'merged'; commit: string; already: boolean }
  | { outcome: 'conflict'; files: string[] };

export interface LandRequest {
  bare: string;
  url: string;
  base: string;
  head: string;
  message: string;
  env: NodeJS.ProcessEnv;
}

const KOALA = { GIT_AUTHOR_NAME: 'Koala', GIT_AUTHOR_EMAIL: 'koala@localhost', GIT_COMMITTER_NAME: 'Koala', GIT_COMMITTER_EMAIL: 'koala@localhost' };
const BASE_REF = 'refs/koala/base';
const HEAD_REF = 'refs/koala/head';
const MOVED_ON = /\[rejected\]|non-fast-forward|fetch first|stale info/i;

export async function landBranch(request: LandRequest, processes: Processes = nodeProcesses): Promise<Landing> {
  const run = (args: readonly string[], env: NodeJS.ProcessEnv = request.env): Promise<ProcessResult> =>
    processes.run({ command: 'git', args: ['--git-dir', request.bare, ...args], env });
  const git = async (...args: string[]): Promise<string> => {
    const result = await run(args);
    if (result.code !== 0) throw new ProcessFailed({ command: 'git', args }, result);
    return result.stdout.trim();
  };
  const contains = async (ancestor: string, of: string): Promise<boolean> => {
    const result = await run(['merge-base', '--is-ancestor', ancestor, of]);
    if (result.code === 0 || result.code === 1) return result.code === 0;
    throw new ProcessFailed({ command: 'git', args: ['merge-base', '--is-ancestor', ancestor, of] }, result);
  };

  await git('init', '--quiet', '--bare', request.bare);
  for (;;) {
    await git('fetch', '--quiet', '--no-tags', request.url, `+refs/heads/${request.base}:${BASE_REF}`, `+refs/heads/${request.head}:${HEAD_REF}`);
    const base = await git('rev-parse', BASE_REF);
    const head = await git('rev-parse', HEAD_REF);
    if (await contains(head, base)) return { outcome: 'merged', commit: base, already: true };

    let landing = head;
    if (!(await contains(base, head))) {
      const merged = await run(['merge-tree', '--write-tree', '--name-only', '--no-messages', base, head]);
      const [tree, ...files] = merged.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
      if (merged.code === 1) return { outcome: 'conflict', files };
      if (merged.code !== 0 || !tree) throw new ProcessFailed({ command: 'git', args: ['merge-tree', base, head] }, merged);
      const made = await run(['commit-tree', tree, '-p', base, '-p', head, '-m', request.message], { ...request.env, ...KOALA });
      if (made.code !== 0) throw new ProcessFailed({ command: 'git', args: ['commit-tree', tree] }, made);
      landing = made.stdout.trim();
    }

    const pushed = await run(['push', '--quiet', request.url, `${landing}:refs/heads/${request.base}`]);
    if (pushed.code === 0) return { outcome: 'merged', commit: landing, already: false };
    if (!MOVED_ON.test(pushed.stderr)) throw new ProcessFailed({ command: 'git', args: ['push', request.url] }, pushed);
  }
}

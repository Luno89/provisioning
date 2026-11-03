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
const done = (result: ProcessResult): boolean => result.code === 0;
const yesOrNo = (result: ProcessResult): boolean => result.code === 0 || result.code === 1;

export async function landBranch(request: LandRequest, processes: Processes = nodeProcesses): Promise<Landing> {
  const run = (args: readonly string[], env: NodeJS.ProcessEnv = request.env): Promise<ProcessResult> =>
    processes.run({ command: 'git', args: ['--git-dir', request.bare, ...args], env });
  const answered = async (args: readonly string[], expected: (result: ProcessResult) => boolean = done, env?: NodeJS.ProcessEnv): Promise<ProcessResult> => {
    const result = await run(args, env);
    if (!expected(result)) throw new ProcessFailed({ command: 'git', args }, result);
    return result;
  };
  const git = async (...args: string[]): Promise<string> => (await answered(args)).stdout.trim();
  const contains = async (ancestor: string, of: string): Promise<boolean> => (await answered(['merge-base', '--is-ancestor', ancestor, of], yesOrNo)).code === 0;

  await git('init', '--quiet', '--bare', request.bare);
  for (;;) {
    await git('fetch', '--quiet', '--no-tags', request.url, `+refs/heads/${request.base}:${BASE_REF}`, `+refs/heads/${request.head}:${HEAD_REF}`);
    const base = await git('rev-parse', BASE_REF);
    const head = await git('rev-parse', HEAD_REF);
    if (await contains(head, base)) return { outcome: 'merged', commit: base, already: true };

    let landing = head;
    if (!(await contains(base, head))) {
      const merged = await answered(['merge-tree', '--write-tree', '--name-only', '--no-messages', base, head], yesOrNo);
      const [tree = '', ...files] = merged.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
      if (merged.code === 1) return { outcome: 'conflict', files };
      landing = (await answered(['commit-tree', tree, '-p', base, '-p', head, '-m', request.message], done, { ...request.env, ...KOALA })).stdout.trim();
    }

    const pushed = await answered(['push', '--quiet', request.url, `${landing}:refs/heads/${request.base}`], (result) => done(result) || MOVED_ON.test(result.stderr));
    if (pushed.code === 0) return { outcome: 'merged', commit: landing, already: false };
  }
}

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import { nodeProcesses, succeeded, type Processes } from '../../platform/index.js';

const IDENTITY = { GIT_AUTHOR_NAME: 'Koala checks', GIT_AUTHOR_EMAIL: 'checks@koala.local', GIT_COMMITTER_NAME: 'Koala checks', GIT_COMMITTER_EMAIL: 'checks@koala.local' };

export async function withSeedBundle<T>(files: Record<string, string>, use: (bundle: string) => Promise<T>, processes: Processes = nodeProcesses): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'koala-seed-'));
  try {
    const repo = join(root, 'repo');
    await mkdir(repo);
    for (const [path, content] of Object.entries(files)) {
      const safe = normalize(path).replace(/^(\.\.(\/|$))+/, '');
      if (!safe || safe.startsWith('/')) throw new Error(`"${path}" is not a path inside the workspace`);
      await mkdir(dirname(join(repo, safe)), { recursive: true });
      await writeFile(join(repo, safe), content);
    }
    const git = (args: string[]): Promise<string> => succeeded(processes, { command: 'git', args, env: IDENTITY });
    await git(['init', '-q', '-b', 'main', repo]);
    await git(['-C', repo, 'add', '-A']);
    await git(['-C', repo, 'commit', '-q', '-m', 'files the check starts with']);
    const bundle = join(root, 'seed.bundle');
    await git(['-C', repo, 'bundle', 'create', bundle, '--all']);
    return await use(bundle);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

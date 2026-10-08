import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';

const run = promisify(execFile);
const IDENTITY = { GIT_AUTHOR_NAME: 'Koala checks', GIT_AUTHOR_EMAIL: 'checks@koala.local', GIT_COMMITTER_NAME: 'Koala checks', GIT_COMMITTER_EMAIL: 'checks@koala.local' };

export async function withSeedBundle<T>(files: Record<string, string>, use: (bundle: string) => Promise<T>): Promise<T> {
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
    const env = { ...process.env, ...IDENTITY };
    await run('git', ['init', '-q', '-b', 'main', repo], { env });
    await run('git', ['-C', repo, 'add', '-A'], { env });
    await run('git', ['-C', repo, 'commit', '-q', '-m', 'files the check starts with'], { env });
    const bundle = join(root, 'seed.bundle');
    await run('git', ['-C', repo, 'bundle', 'create', bundle, '--all'], { env });
    return await use(bundle);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

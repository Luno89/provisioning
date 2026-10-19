import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile, spawn } from 'child_process';
import { createReadStream, createWriteStream } from 'fs';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile, access } from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import type { KubeRunner, KubeStreamer } from './kube.js';
import { createWorkspaceDocuments, type DocumentRepos } from './workspace-documents.js';
import { createTreeWorkspaces, treeRepoName } from './tree-workspaces.js';
import type { EnvironmentResolver } from './environments.js';

const git = promisify(execFile);

let root: string;
let podRunning: boolean;
let calls: string[][];
let pushed: { repo: string; describe: string; files: Record<string, string>; bundle: string }[];
let pushFails: string | undefined;
let guardMain: boolean;

const local = (args: string[]): string[] => {
  const command = args.slice(args.indexOf('--') + 1);
  return command
    .map((part) => part.replaceAll('/tmp/koala-restore.bundle', path.join(root, 'incoming.bundle')))
    .map((part) => (part.startsWith('/work') ? path.join(root, part) : part));
};

const kube: KubeRunner = async (args) => {
  calls.push(args);
  if (args[0] === 'get') return { stdout: podRunning ? 'Running' : '', stderr: '', exitCode: podRunning ? 0 : 1 };
  if (args[0] !== 'exec') return { stdout: '', stderr: '', exitCode: 0 };
  const [binary, ...rest] = local(args);
  return new Promise((resolve) => {
    const child = spawn(binary!, rest, { cwd: root });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('close', (code) => resolve({ stdout, stderr, exitCode: code ?? -1 }));
  });
};

const stream: KubeStreamer = {
  toFile: async (args, destination) => {
    calls.push(args);
    const [binary, ...rest] = local(args);
    return new Promise((resolve) => {
      const child = spawn(binary!, rest, { cwd: root });
      const out = createWriteStream(destination);
      let stderr = '';
      child.stdout.pipe(out);
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      child.on('close', (code) => out.end(() => resolve({ exitCode: code ?? -1, stderr })));
    });
  },
  fromFile: async (args, source) => {
    calls.push(args);
    const [binary, ...rest] = local(args);
    return new Promise((resolve) => {
      const child = spawn(binary!, rest, { cwd: root });
      let stderr = '';
      child.stdout.resume();
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      child.on('close', (code) => resolve({ exitCode: code ?? -1, stderr }));
      createReadStream(source).pipe(child.stdin);
    });
  },
};

const remote = (repo: string): string => path.join(root, `remote-${repo}.bundle`);

const repos: DocumentRepos = {
  async push({ repo, describe, bundle }) {
    if (pushFails) throw new Error(pushFails);
    const clone = path.join(root, `clone-${pushed.length}-${Math.random().toString(36).slice(2, 6)}`);
    await git('git', ['clone', '-q', bundle, clone]);
    if (guardMain && await access(remote(repo)).then(() => true, () => false)) {
      await git('git', ['-C', clone, 'fetch', '-q', remote(repo), '+refs/heads/main:refs/saved/main']);
      const behind = await git('git', ['-C', clone, 'merge-base', '--is-ancestor', 'refs/saved/main', 'origin/main']).then(() => false, () => true);
      if (behind) throw new Error(`Pushing to koala-u1/${repo} failed: To http://gitea/koala-u1/${repo}.git\n ! [rejected]        main -> main (fetch first)`);
    }
    const listed = (await git('git', ['-C', clone, 'ls-files'])).stdout.trim().split('\n').filter(Boolean);
    const files: Record<string, string> = {};
    for (const file of listed) files[file] = await readFile(path.join(clone, file), 'utf8');
    pushed.push({ repo, describe, files, bundle });
    await copyFile(bundle, remote(repo));
    return { owner: 'koala-u1', repo, commit: (await git('git', ['-C', clone, 'rev-parse', 'HEAD'])).stdout.trim() };
  },
  async merge({ repo, head, base }) {
    const clone = path.join(root, `merge-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    await git('git', ['clone', '-q', remote(repo), clone]);
    await git('git', ['-C', clone, 'checkout', '-q', base]);
    const merged = await git('git', ['-C', clone, '-c', 'user.name=gitea', '-c', 'user.email=g@g', 'merge', '-q', '--no-ff', '--no-edit', `origin/${head}`]).then(() => true, () => false);
    if (!merged) return 'conflict' as const;
    for (const branch of (await git('git', ['-C', clone, 'branch', '-r', '--format=%(refname:short)'])).stdout.split('\n').filter((name) => name && !name.endsWith('/HEAD') && name !== `origin/${base}`)) {
      await git('git', ['-C', clone, 'branch', '-q', '-f', branch.replace(/^origin\//, ''), branch]);
    }
    await git('git', ['-C', clone, 'bundle', 'create', remote(repo), '--all']);
    return 'merged' as const;
  },
  async pull({ repo, bundle }) {
    try {
      await copyFile(remote(repo), bundle);
      return true;
    } catch {
      return false;
    }
  },
};

const documents = () => createWorkspaceDocuments({ kube, stream, repos });

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'documents-test-'));
  podRunning = true;
  calls = [];
  pushed = [];
  pushFails = undefined;
  guardMain = false;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('saving a workspace\'s documents', () => {
  it('commits everything under the path and pushes it as a bundle, so the repository holds exactly what the agents wrote', async () => {
    await mkdir(path.join(root, 'work/research/r1/sources'), { recursive: true });
    await writeFile(path.join(root, 'work/research/r1/findings.md'), '# Findings\n');
    await writeFile(path.join(root, 'work/research/r1/sources/a.md'), 'a source\n');

    const saved = await documents().save({ ownerId: 'u1', workspaceRunId: 'conversation-c1', path: '/work', repo: 'research-c1', describe: 'Research from conversation c1', commitAs: 'turn 3' });

    expect(saved).toMatchObject({ saved: true, owner: 'koala-u1', repo: 'research-c1' });
    expect(pushed[0]!.files).toEqual({ 'research/r1/findings.md': '# Findings\n', 'research/r1/sources/a.md': 'a source\n' });
    expect((await git('git', ['-C', path.join(root, 'work'), 'log', '--format=%s'])).stdout.trim()).toBe('turn 3');
    await expect(access(pushed[0]!.bundle)).rejects.toThrow();
  });

  it('adds a commit only when something changed, and leaves an existing repository\'s history alone when not asked to commit', async () => {
    await mkdir(path.join(root, 'work/repo'), { recursive: true });
    await git('git', ['-C', path.join(root, 'work/repo'), 'init', '-q', '-b', 'main']);
    await writeFile(path.join(root, 'work/repo/PLAN.md'), 'plan\n');
    await git('git', ['-C', path.join(root, 'work/repo'), 'add', '-A']);
    await git('git', ['-C', path.join(root, 'work/repo'), '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'plan: p1']);
    await writeFile(path.join(root, 'work/repo/stray.txt'), 'not committed by grove\n');

    const saved = await documents().save({ ownerId: 'u1', workspaceRunId: 'tree-t1', path: '/work/repo', repo: 'tree-t1', describe: 'tree' });

    expect(saved.saved).toBe(true);
    expect(Object.keys(pushed[0]!.files)).toEqual(['PLAN.md']);
    expect((await git('git', ['-C', path.join(root, 'work/repo'), 'log', '--format=%s'])).stdout.trim()).toBe('plan: p1');
  });

  it('says why nothing was saved when the workspace is stopped, the path is missing, or nothing is committed', async () => {
    podRunning = false;
    expect(await documents().save({ ownerId: 'u1', workspaceRunId: 'tree-t1', path: '/work/repo', repo: 'tree-t1', describe: 'tree' })).toEqual({ saved: false, why: 'the workspace is not running' });

    podRunning = true;
    expect(await documents().save({ ownerId: 'u1', workspaceRunId: 'tree-t1', path: '/work/repo', repo: 'tree-t1', describe: 'tree' })).toEqual({ saved: false, empty: true, why: '/work/repo does not exist in the workspace' });

    await mkdir(path.join(root, 'work/repo'), { recursive: true });
    await git('git', ['-C', path.join(root, 'work/repo'), 'init', '-q']);
    expect(await documents().save({ ownerId: 'u1', workspaceRunId: 'tree-t1', path: '/work/repo', repo: 'tree-t1', describe: 'tree' })).toEqual({ saved: false, empty: true, why: '/work/repo has nothing committed' });
    expect(pushed).toEqual([]);
  });
});

describe('saving after main was changed somewhere else', () => {
  const tree = { ownerId: 'u1', workspaceRunId: 'tree-t1', path: '/work/repo', repo: 'tree-t1', describe: 'tree' };
  const commitIn = async (dir: string, file: string, content: string, message: string) => {
    await writeFile(path.join(dir, file), content);
    await git('git', ['-C', dir, 'add', '-A']);
    await git('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', message]);
  };
  const editSaved = async (file: string, content: string) => {
    const elsewhere = path.join(root, `elsewhere-${Math.random().toString(36).slice(2, 6)}`);
    await git('git', ['clone', '-q', '-b', 'main', remote('tree-t1'), elsewhere]);
    await commitIn(elsewhere, file, content, `Update ${file}`);
    await git('git', ['-C', elsewhere, 'bundle', 'create', remote('tree-t1'), '--all']);
  };
  const work = () => path.join(root, 'work/repo');

  beforeEach(async () => {
    guardMain = true;
    await mkdir(work(), { recursive: true });
    await git('git', ['-C', work(), 'init', '-q', '-b', 'main']);
    await commitIn(work(), 'PLAN.md', 'plan\n', 'plan: p1');
    await documents().save(tree);
  });

  it('brings in what was saved to main elsewhere, merges it with what the workspace added, and saves both', async () => {
    await editSaved('README.md', 'edited in the editor\n');
    await commitIn(work(), 'leaves.md', 'a new story\n', 'change: p2');

    const saved = await documents().save(tree);

    expect(saved).toMatchObject({ saved: true });
    expect(pushed.at(-1)!.files).toEqual({ 'PLAN.md': 'plan\n', 'README.md': 'edited in the editor\n', 'leaves.md': 'a new story\n' });
    expect((await git('git', ['-C', work(), 'log', '-1', '--format=%s'])).stdout.trim()).toBe('Merge what was saved to main elsewhere');
    expect((await git('git', ['-C', work(), 'show-ref'])).stdout).not.toContain('refs/koala/saved-main');
  });

  it('refuses with the files that conflict, and leaves the workspace as it was', async () => {
    await editSaved('PLAN.md', 'the editor\'s plan\n');
    await commitIn(work(), 'PLAN.md', 'the workspace\'s plan\n', 'change: p2');
    const before = (await git('git', ['-C', work(), 'rev-parse', 'HEAD'])).stdout.trim();

    await expect(documents().save(tree)).rejects.toThrow('tree-t1 could not be saved: main was changed elsewhere in a way that conflicts with this workspace: PLAN.md');
    expect((await git('git', ['-C', work(), 'rev-parse', 'HEAD'])).stdout.trim()).toBe(before);
    expect((await git('git', ['-C', work(), 'status', '--porcelain'])).stdout.trim()).toBe('');
  });
});

describe('a save that goes wrong', () => {
  it('is an error, never mistaken for having nothing to save', async () => {
    await mkdir(path.join(root, 'work/research/r1'), { recursive: true });
    await writeFile(path.join(root, 'work/research/r1/findings.md'), 'kept\n');
    await writeFile(path.join(root, 'work/research/r1/locked.md'), 'unreadable\n', { mode: 0o000 });

    await expect(documents().save({ ownerId: 'u1', workspaceRunId: 'conversation-c1', path: '/work', repo: 'research-c1', describe: 'd', commitAs: 'turn 1' }))
      .rejects.toThrow(/could not prepare \/work to save/);
    expect(pushed).toEqual([]);
  });
});

describe('restoring a workspace from what was saved', () => {
  it('brings a new workspace back to exactly what was last saved, so its next save carries on the same history', async () => {
    await mkdir(path.join(root, 'work/research/r1'), { recursive: true });
    await writeFile(path.join(root, 'work/research/r1/findings.md'), 'first\n');
    const first = await documents().save({ ownerId: 'u1', workspaceRunId: 'conversation-c1', path: '/work', repo: 'research-c1', describe: 'd', commitAs: 'turn 1' });
    await rm(path.join(root, 'work'), { recursive: true, force: true });

    expect(await documents().restore({ ownerId: 'u1', workspaceRunId: 'conversation-c1', path: '/work', repo: 'research-c1' })).toEqual({ restored: true });
    expect(await readFile(path.join(root, 'work/research/r1/findings.md'), 'utf8')).toBe('first\n');

    await mkdir(path.join(root, 'work/research/r2'), { recursive: true });
    await writeFile(path.join(root, 'work/research/r2/findings.md'), 'second\n');
    await documents().save({ ownerId: 'u1', workspaceRunId: 'conversation-c1', path: '/work', repo: 'research-c1', describe: 'd', commitAs: 'turn 2' });

    expect(pushed[1]!.files).toEqual({ 'research/r1/findings.md': 'first\n', 'research/r2/findings.md': 'second\n' });
    expect((await git('git', ['-C', path.join(root, 'work'), 'log', '--format=%s'])).stdout.trim().split('\n')).toEqual(['turn 2', 'turn 1']);
    expect(first.saved && (await git('git', ['-C', path.join(root, 'work'), 'merge-base', '--is-ancestor', first.commit, 'HEAD'])).stdout).toBe('');
  });

  it('leaves a workspace that already has its history alone, and says when there is nothing saved to restore', async () => {
    expect(await documents().restore({ ownerId: 'u1', workspaceRunId: 'conversation-c1', path: '/work', repo: 'research-c1' })).toEqual({ restored: false, why: 'nothing has been saved to research-c1 yet' });

    await mkdir(path.join(root, 'work'), { recursive: true });
    await git('git', ['-C', path.join(root, 'work'), 'init', '-q']);
    expect(await documents().restore({ ownerId: 'u1', workspaceRunId: 'conversation-c1', path: '/work', repo: 'research-c1' })).toEqual({ restored: false, why: '/work already has its history' });
  });
});

describe('bringing another repository\'s documents into a workspace', () => {
  const saveConversation = async () => {
    await mkdir(path.join(root, 'work/research/r1'), { recursive: true });
    await writeFile(path.join(root, 'work/research/r1/findings.md'), '# Findings\n');
    await writeFile(path.join(root, 'work/PLAN.md'), 'the conversation\'s idea of a plan\n');
    await documents().save({ ownerId: 'u1', workspaceRunId: 'conversation-c1', path: '/work', repo: 'research-c1', describe: 'Research', commitAs: 'turn 1' });
  };

  it('stages each file at its own path and leaves every path the repository already has as it was', async () => {
    await saveConversation();
    const tree = path.join(root, 'work/repo');
    await mkdir(tree, { recursive: true });
    await git('git', ['-C', tree, 'init', '-q', '-b', 'main']);
    await writeFile(path.join(tree, 'PLAN.md'), 'the tree\'s plan\n');

    const brought = await documents().bring({ ownerId: 'u1', workspaceRunId: 'tree-t1', path: '/work/repo', repo: 'tree-t1', from: 'research-c1' });

    expect(brought).toEqual({ brought: ['research/r1/findings.md'] });
    expect(await readFile(path.join(tree, 'research/r1/findings.md'), 'utf8')).toBe('# Findings\n');
    expect(await readFile(path.join(tree, 'PLAN.md'), 'utf8')).toBe('the tree\'s plan\n');
    expect((await git('git', ['-C', tree, 'diff', '--cached', '--name-only'])).stdout.trim()).toBe('research/r1/findings.md');
    expect((await git('git', ['-C', tree, 'for-each-ref'])).stdout.trim()).toBe('');
    await expect(access(path.join(root, 'incoming.bundle'))).rejects.toThrow();
  });

  it('brings nothing when nothing was saved, and is an error when the repository cannot take it', async () => {
    expect(await documents().bring({ ownerId: 'u1', workspaceRunId: 'tree-t1', path: '/work/repo', repo: 'tree-t1', from: 'research-c1' }))
      .toEqual({ brought: false, why: 'nothing has been saved to research-c1' });

    await saveConversation();
    await expect(documents().bring({ ownerId: 'u1', workspaceRunId: 'tree-t1', path: '/work/missing', repo: 'tree-t1', from: 'research-c1' }))
      .rejects.toThrow('could not bring research-c1 into /work/missing');
  });
});

describe('a tree\'s workspace keeps its repository in Gitea', () => {
  const resolver = {} as EnvironmentResolver;
  const commitTree = async () => {
    await mkdir(path.join(root, 'work/repo'), { recursive: true });
    await git('git', ['-C', path.join(root, 'work/repo'), 'init', '-q', '-b', 'main']);
    await writeFile(path.join(root, 'work/repo/PLAN.md'), 'plan\n');
    await git('git', ['-C', path.join(root, 'work/repo'), 'add', '-A']);
    await git('git', ['-C', path.join(root, 'work/repo'), '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'plan']);
  };
  const deleted = () => calls.filter((args) => args[0] === 'delete').map((args) => args.slice(0, 2).join(' '));

  it('saves the tree\'s repository to its own repo before parking', async () => {
    await commitTree();
    const workspaces = createTreeWorkspaces({ resolver, kube, documents: documents() });

    const saved = await workspaces.park('t1', 'u1');

    expect(saved).toMatchObject({ saved: true, repo: treeRepoName('t1') });
    expect(pushed[0]!.files).toEqual({ 'PLAN.md': 'plan\n' });
    expect(deleted()).toEqual(['delete pod']);
  });

  it('keeps the pod running when the save fails, so nothing unsaved is parked', async () => {
    await commitTree();
    pushFails = 'Gitea is down';
    const workspaces = createTreeWorkspaces({ resolver, kube, documents: documents() });

    expect(await workspaces.park('t1', 'u1')).toEqual({ saved: false, why: 'Gitea is down', failed: true });
    expect(deleted()).toEqual([]);
  });

  it('refuses to delete the workspace when the save fails', async () => {
    await commitTree();
    pushFails = 'Gitea is down';
    const workspaces = createTreeWorkspaces({ resolver, kube, documents: documents() });

    await expect(workspaces.release('t1', 'u1')).rejects.toThrow('Gitea is down');
    expect(deleted()).toEqual([]);

    pushFails = undefined;
    expect((await workspaces.release('t1', 'u1')).saved).toBe(true);
    expect(deleted()).toEqual(['delete namespace']);
  });
});

describe('landing a tree\'s verified leaves', () => {
  const resolver = {} as EnvironmentResolver;
  const repo = () => path.join(root, 'work/repo');
  const commit = async (where: string, file: string, content: string, message: string) => {
    await writeFile(path.join(where, file), content);
    await git('git', ['-C', where, 'add', '-A']);
    await git('git', ['-C', where, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', message]);
  };
  const tree = async () => {
    await mkdir(repo(), { recursive: true });
    await git('git', ['-C', repo(), 'init', '-q', '-b', 'main']);
    await commit(repo(), 'PLAN.md', 'plan\n', 'plan');
  };
  const leafWork = async (leafId: string, file: string, content: string) => {
    await git('git', ['-C', repo(), 'checkout', '-q', '-b', `leaf/${leafId}`, 'main']);
    await commit(repo(), file, content, `leaf ${leafId}`);
    await git('git', ['-C', repo(), 'checkout', '-q', 'main']);
  };

  it('merges each leaf into main in Gitea and brings main back into the workspace, so the next leaves start from it', async () => {
    await tree();
    await leafWork('a', 'greet.js', 'hello\n');
    await leafWork('b', 'test.sh', 'echo ok\n');
    const workspaces = createTreeWorkspaces({ resolver, kube, documents: documents() });

    const landed = await workspaces.land('t1', 'u1', [{ leafId: 'a', title: 'Greeter' }, { leafId: 'b', title: 'Test' }]);

    expect(landed).toEqual([{ leafId: 'a', outcome: 'merged' }, { leafId: 'b', outcome: 'merged' }]);
    expect(await readFile(path.join(repo(), 'greet.js'), 'utf8')).toBe('hello\n');
    expect(await readFile(path.join(repo(), 'test.sh'), 'utf8')).toBe('echo ok\n');
    expect((await git('git', ['-C', repo(), 'symbolic-ref', '--short', 'HEAD'])).stdout.trim()).toBe('main');
  });

  it('reports a leaf whose work conflicts with what landed first, and leaves main as Gitea has it', async () => {
    await tree();
    await leafWork('a', 'PLAN.md', 'plan as a sees it\n');
    await leafWork('b', 'PLAN.md', 'plan as b sees it\n');
    const workspaces = createTreeWorkspaces({ resolver, kube, documents: documents() });

    const landed = await workspaces.land('t1', 'u1', [{ leafId: 'a', title: 'A' }, { leafId: 'b', title: 'B' }]);

    expect(landed).toEqual([{ leafId: 'a', outcome: 'merged' }, { leafId: 'b', outcome: 'conflict' }]);
    expect(await readFile(path.join(repo(), 'PLAN.md'), 'utf8')).toBe('plan as a sees it\n');
  });
});

describe('a workspace folder going to a machine and coming back', () => {
  const branches = new Map<string, string>();
  const machineRepos = (): DocumentRepos => ({
    ...repos,
    async pushBranch({ bundle, branch }) {
      const kept = path.join(root, `branch-${branches.size}.bundle`);
      await copyFile(bundle, kept);
      branches.set(branch, kept);
      return 'pushed';
    },
    async pullBranch({ branch, bundle }) {
      const kept = branches.get(branch);
      if (!kept) return false;
      await copyFile(kept, bundle);
      return true;
    },
    async deleteBranch({ branch }) { branches.delete(branch); },
  });
  const folder = () => path.join(root, 'work', 'trees', 'l1');
  const inFolder = (...args: string[]) => git('git', ['-C', folder(), '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]).then((out) => out.stdout.trim());
  const request = { ownerId: 'u1', workspaceRunId: 'tree-t1', repo: 'tree-t1', folder: '/work/trees/l1', branch: 'machine/desk/run-1', describe: 'The repository of grove tree t1' };

  const machineCommits = async (files: Record<string, string>) => {
    const machine = path.join(root, `machine-${Math.random().toString(36).slice(2, 8)}`);
    await git('git', ['clone', '-q', '-b', request.branch, branches.get(request.branch)!, machine]);
    for (const [name, content] of Object.entries(files)) await writeFile(path.join(machine, name), content);
    await git('git', ['-C', machine, 'add', '-A']);
    await git('git', ['-C', machine, '-c', 'user.name=m', '-c', 'user.email=m@m', 'commit', '-q', '-m', 'machine files']);
    const bundle = path.join(machine, 'out.bundle');
    await git('git', ['-C', machine, 'bundle', 'create', bundle, request.branch]);
    branches.set(request.branch, bundle);
  };

  beforeEach(async () => {
    branches.clear();
    await mkdir(folder(), { recursive: true });
    await inFolder('init', '-q', '-b', 'leaf/l1');
    await writeFile(path.join(folder(), 'README.md'), 'labels\n');
    await inFolder('add', '-A');
    await inFolder('commit', '-q', '-m', 'start');
  });

  it('sends what the folder holds, committed or not, as that branch alone, and leaves the folder on its own branch', async () => {
    await writeFile(path.join(folder(), 'notes.md'), 'left by the model\n');
    const sent = await createWorkspaceDocuments({ kube, stream, repos: machineRepos() }).sendBranch({ ...request, message: 'Work so far' });

    expect(sent.commit).toBe(await inFolder('rev-parse', 'HEAD'));
    expect(await inFolder('log', '--format=%s')).toBe('Work so far\nstart');
    expect(await inFolder('rev-parse', '--abbrev-ref', 'HEAD')).toBe('leaf/l1');
    expect(await inFolder('branch', '--list', 'machine/*')).toBe('');
    const heads = (await git('git', ['bundle', 'list-heads', branches.get(request.branch)!])).stdout.trim();
    expect(heads).toBe(`${sent.commit} refs/heads/${request.branch}`);
  });

  it('lays the machine\'s commits over the folder, setting aside anything uncommitted in the way, merges them in when the folder moved on, and names the files when it cannot', async () => {
    const documents = createWorkspaceDocuments({ kube, stream, repos: machineRepos() });
    await documents.sendBranch({ ...request, message: 'Work so far' });
    await machineCommits({ 'label.txt': 'Axial Concepts\n' });
    await writeFile(path.join(folder(), 'label.txt'), 'built by a check\n');

    const taken = await documents.takeBranch(request);

    expect(taken).toMatchObject({ brought: true, commit: await inFolder('rev-parse', 'HEAD') });
    expect(taken.brought && taken.set).toMatch(/^[0-9a-f]{40}$/);
    expect(await readFile(path.join(folder(), 'label.txt'), 'utf8')).toBe('Axial Concepts\n');
    expect(await inFolder('rev-parse', '--abbrev-ref', 'HEAD')).toBe('leaf/l1');
    expect(await inFolder('stash', 'list')).toContain('set aside when the machine');

    await documents.sendBranch({ ...request, message: 'Again' });
    await machineCommits({ 'more.txt': 'more\n' });
    await writeFile(path.join(folder(), 'own.txt'), 'own\n');
    await inFolder('add', '-A');
    await inFolder('commit', '-q', '-m', 'the folder moved on');
    const merged = await documents.takeBranch({ ...request, message: 'Merge antigravity\'s work from Desk' });
    expect(merged).toMatchObject({ brought: true, merged: true, commit: await inFolder('rev-parse', 'HEAD') });
    expect(await inFolder('log', '-1', '--format=%s')).toBe('Merge antigravity\'s work from Desk');
    expect(await readFile(path.join(folder(), 'more.txt'), 'utf8')).toBe('more\n');
    expect(await readFile(path.join(folder(), 'own.txt'), 'utf8')).toBe('own\n');

    await documents.sendBranch({ ...request, message: 'Once more' });
    await machineCommits({ 'label.txt': 'the machine\'s label\n' });
    await writeFile(path.join(folder(), 'label.txt'), 'another agent\'s label\n');
    await inFolder('add', '-A');
    await inFolder('commit', '-q', '-m', 'another agent landed first');
    await writeFile(path.join(folder(), 'scratch.txt'), 'uncommitted\n');
    expect(await documents.takeBranch(request)).toEqual({ brought: false, why: expect.stringContaining('these files conflict: label.txt'), conflicts: ['label.txt'] });
    expect(await inFolder('log', '-1', '--format=%s')).toBe('another agent landed first');
    expect(await readFile(path.join(folder(), 'label.txt'), 'utf8')).toBe('another agent\'s label\n');
    expect(await readFile(path.join(folder(), 'scratch.txt'), 'utf8')).toBe('uncommitted\n');
    expect(await inFolder('status', '--porcelain')).toBe('?? scratch.txt');

    const kept = await documents.keepBranch(request);
    expect(kept).toMatchObject({ kept: true });
    expect(await inFolder('show', `${request.branch}:label.txt`)).toBe('the machine\'s label');
    expect(await inFolder('rev-parse', '--abbrev-ref', 'HEAD')).toBe('leaf/l1');
  });

  it('starts the history of a folder that has none, so a conversation with nothing saved yet can still send its work', async () => {
    const fresh = path.join(root, 'work', 'research');
    const asked = { ...request, workspaceRunId: 'conversation-c1', repo: 'research-c1', folder: '/work/research', describe: 'Documents written in conversation c1' };
    const documents = createWorkspaceDocuments({ kube, stream, repos: machineRepos() });

    const empty = await documents.sendBranch({ ...asked, message: 'Nothing yet' });
    await writeFile(path.join(fresh, 'notes.md'), 'found\n');
    const written = await documents.sendBranch({ ...asked, message: 'Notes so far' });

    const log = (await git('git', ['-C', fresh, 'log', '--format=%H %s'])).stdout.trim().split('\n');
    expect(log).toEqual([`${written.commit} Notes so far`, `${empty.commit} Nothing yet`]);
    expect((await git('git', ['-C', fresh, 'symbolic-ref', '--short', 'HEAD'])).stdout.trim()).toBe('main');
  });

  it('says so when the machine never sent its work', async () => {
    expect(await createWorkspaceDocuments({ kube, stream, repos: machineRepos() }).takeBranch(request)).toEqual({ brought: false, why: 'the machine has not sent machine/desk/run-1' });
  });
});

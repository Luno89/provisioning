import { http, HttpResponse } from 'msw';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { decryptValue, encryptValue } from '../../platform/lib/crypto.js';
import { containing } from '../../platform/lib/test-matchers.js';
import { interceptHttp } from '../../platform/testing/http.js';
import { GiteaConflictError, GiteaService } from './GiteaService.js';
import type { ProcessResult, Processes } from '../../platform/lib/processes.js';

const KEY = 'test-master-key-for-unit-tests-only' as never;
const BASE = 'http://gitea.test';
const ADMIN = `Basic ${Buffer.from('provisioning-bot:admin-pass').toString('base64')}`;
const ALL_SCOPES = ['write:repository', 'write:package', 'write:admin', 'write:user', 'write:organization'];

type GitRun = Parameters<Processes['run']>[0];

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'gitea-unit-'));
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const server = interceptHttp();

function setUp() {
  const processes = mock<Processes>();
  const gitea = new GiteaService(KEY, { url: BASE }, { processes, dataDir });
  return { processes, gitea };
}

const said = (run: GitRun): string => run.args.filter((arg) => !arg.endsWith('repo.git')).join(' ');
const writeData = (name: string, content: string) => writeFileSync(path.join(dataDir, name), content);
const dataFile = (name: string) => path.join(dataDir, name);

describe('the admin password and token Koala keeps for Gitea', () => {
  it('reads the admin password from its file, trimmed', async () => {
    const { gitea } = setUp();
    writeData('.gitea-admin-password', '  admin-pass\n');
    expect(await gitea.getAdminCredentials()).toEqual({ username: 'provisioning-bot', password: 'admin-pass' });
  });

  it('fails when the admin password was never written', async () => {
    const { gitea } = setUp();
    await expect(gitea.getAdminCredentials()).rejects.toThrow(/ENOENT/);
  });

  it('uses the stored token while Gitea accepts it and it holds every scope, asking nothing more afterwards', async () => {
    const { gitea } = setUp();
    writeData('.gitea-admin-token', encryptValue('stored-token', KEY));
    writeData('.gitea-admin-token.scopes', JSON.stringify(ALL_SCOPES));
    const seen: string[] = [];
    server.use(
      http.get(`${BASE}/api/v1/user`, ({ request }) => { seen.push(`user ${request.headers.get('authorization')}`); return HttpResponse.json({}); }),
      http.get(`${BASE}/api/v1/repos/acme/demo/git/commits/abc`, ({ request }) => { seen.push(`commit ${request.headers.get('authorization')}`); return HttpResponse.json({ commit: { message: 'm' } }); }),
    );
    await gitea.getCommit('acme', 'demo', 'abc');
    await gitea.getCommit('acme', 'demo', 'abc');
    expect(seen).toEqual(['user token stored-token', 'commit token stored-token', 'commit token stored-token']);
  });

  describe('when a new token has to be made', () => {
    const mintsToken = (made: unknown[]) => http.post(`${BASE}/api/v1/users/provisioning-bot/tokens`, async ({ request }) => {
      made.push({ auth: request.headers.get('authorization'), body: await request.json() });
      return HttpResponse.json({ sha1: 'fresh-token' });
    });

    it('makes one with the admin password when none is stored and seals it on disk with its scopes', async () => {
      const { gitea } = setUp();
      writeData('.gitea-admin-password', 'admin-pass\n');
      const made: unknown[] = [];
      server.use(mintsToken(made), http.get(`${BASE}/api/v1/repos/acme/demo/git/commits/abc`, ({ request }) => {
        expect(request.headers.get('authorization')).toBe('token fresh-token');
        return HttpResponse.json({ commit: { message: 'm' } });
      }));
      await gitea.getCommit('acme', 'demo', 'abc');
      expect(made).toEqual([{ auth: ADMIN, body: { name: expect.stringMatching(/^backend-[0-9a-f]{8}$/) as unknown as string, scopes: ALL_SCOPES } }]);
      expect(decryptValue(readFileSync(dataFile('.gitea-admin-token'), 'utf8'), KEY)).toBe('fresh-token');
      expect(readFileSync(dataFile('.gitea-admin-token'), 'utf8')).not.toContain('fresh-token');
      expect(JSON.parse(readFileSync(dataFile('.gitea-admin-token.scopes'), 'utf8'))).toEqual(ALL_SCOPES);
    });

    it('replaces a stored token Gitea no longer accepts', async () => {
      const { gitea } = setUp();
      writeData('.gitea-admin-password', 'admin-pass');
      writeData('.gitea-admin-token', encryptValue('revoked', KEY));
      writeData('.gitea-admin-token.scopes', JSON.stringify(ALL_SCOPES));
      const made: unknown[] = [];
      server.use(
        http.get(`${BASE}/api/v1/user`, () => new HttpResponse(null, { status: 401 })),
        mintsToken(made),
        http.get(`${BASE}/api/v1/repos/a/b/git/commits/c`, () => HttpResponse.json({ commit: { message: 'm' } })),
      );
      await gitea.getCommit('a', 'b', 'c');
      expect(made).toHaveLength(1);
      expect(decryptValue(readFileSync(dataFile('.gitea-admin-token'), 'utf8'), KEY)).toBe('fresh-token');
    });

    it('replaces a stored token that lacks a scope Koala now needs', async () => {
      const { gitea } = setUp();
      writeData('.gitea-admin-password', 'admin-pass');
      writeData('.gitea-admin-token', encryptValue('narrow', KEY));
      writeData('.gitea-admin-token.scopes', JSON.stringify(['write:repository']));
      const made: unknown[] = [];
      server.use(
        http.get(`${BASE}/api/v1/user`, () => HttpResponse.json({})),
        mintsToken(made),
        http.get(`${BASE}/api/v1/repos/a/b/git/commits/c`, () => HttpResponse.json({ commit: { message: 'm' } })),
      );
      await gitea.getCommit('a', 'b', 'c');
      expect(made).toHaveLength(1);
    });

    it('says why when Gitea refuses to make one, and writes nothing', async () => {
      const { gitea } = setUp();
      writeData('.gitea-admin-password', 'admin-pass');
      server.use(http.post(`${BASE}/api/v1/users/provisioning-bot/tokens`, () => new HttpResponse('bad password', { status: 401 })));
      await expect(gitea.getCommit('a', 'b', 'c')).rejects.toThrow('Failed to mint Gitea API token: HTTP 401 bad password');
      expect(existsSync(dataFile('.gitea-admin-token'))).toBe(false);
    });
  });
});

describe('calling Gitea\'s API as the bot', () => {
  function holdingToken() {
    const made = setUp();
    writeData('.gitea-admin-token', encryptValue('bot-token', KEY));
    writeData('.gitea-admin-token.scopes', JSON.stringify(ALL_SCOPES));
    server.use(http.get(`${BASE}/api/v1/user`, () => HttpResponse.json({})));
    return made;
  }

  it('sends the token with every request, and the content type only when there is a body', async () => {
    const { gitea } = holdingToken();
    const seen: { method: string; auth: string | null; type: string | null; body: unknown }[] = [];
    server.use(
      http.post(`${BASE}/api/v1/user/repos`, async ({ request }) => { seen.push({ method: 'POST', auth: request.headers.get('authorization'), type: request.headers.get('content-type'), body: await request.json() }); return HttpResponse.json({ owner: { login: 'provisioning-bot' }, name: 'demo', clone_url: 'http://gitea.test/provisioning-bot/demo.git' }); }),
      http.get(`${BASE}/api/v1/repos/acme/demo/git/commits/abc`, ({ request }) => { seen.push({ method: 'GET', auth: request.headers.get('authorization'), type: request.headers.get('content-type'), body: null }); return HttpResponse.json({ commit: { message: 'm' } }); }),
    );
    expect(await gitea.createRepo('demo', { description: 'd' })).toEqual({ owner: 'provisioning-bot', name: 'demo', cloneUrl: 'http://gitea.test/provisioning-bot/demo.git' });
    await gitea.getCommit('acme', 'demo', 'abc');
    expect(seen).toEqual([
      { method: 'POST', auth: 'token bot-token', type: 'application/json', body: { name: 'demo', private: true, description: 'd', auto_init: true } },
      { method: 'GET', auth: 'token bot-token', type: null, body: null },
    ]);
  });

  it('reaches Gitea only at the address it was given', async () => {
    const { gitea } = holdingToken();
    const asked: string[] = [];
    server.use(http.get(`${BASE}/api/v1/repos/a/b/git/commits/c`, ({ request }) => { asked.push(request.url); return HttpResponse.json({ commit: { message: 'm' } }); }));
    await gitea.getCommit('a', 'b', 'c');
    expect(asked).toEqual([`${BASE}/api/v1/repos/a/b/git/commits/c`]);
  });

  it('refuses every call with the reason it was given where it reaches no Gitea, asking nothing', async () => {
    const gitea = new GiteaService(KEY, { none: 'root keeps no repositories, so it reaches no Gitea' }, { processes: mock<Processes>(), dataDir });
    await expect(gitea.getCommit('a', 'b', 'c')).rejects.toThrow('root keeps no repositories, so it reaches no Gitea');
    await expect(gitea.getRegistryHosts()).rejects.toThrow('root keeps no repositories, so it reaches no Gitea');
    await expect(gitea.repoGitUrl('a', 'b')).rejects.toThrow('root keeps no repositories, so it reaches no Gitea');
  });
});

describe('running git against a repository on Gitea', () => {
  const ok = (stdout = ''): ProcessResult => ({ code: 0, stdout, stderr: '' });
  const auth = { username: 'koala-u1', token: 'tok-secret' };

  function scripted(steps: [words: string, answer: ProcessResult | Error][]) {
    const made = setUp();
    const seen: GitRun[] = [];
    made.processes.run.mockImplementation(async (run) => {
      seen.push(run);
      const said = run.args.join(' ');
      const step = steps.find(([words]) => said.includes(words));
      if (step?.[1] instanceof Error) throw step[1];
      return step?.[1] ?? ok();
    });
    return { ...made, seen };
  }

  const scratchOf = (run: GitRun): string => run.args.find((arg) => arg.endsWith('repo.git'))!;

  it('works in a scratch folder and removes it afterwards, whether or not git succeeds', async () => {
    const { gitea, seen } = scripted([['rev-parse HEAD', ok('abc123\n')]]);
    expect(await gitea.pushBundle(auth, 'koala-u1', 'shop', '/tmp/b.bundle')).toBe('abc123');
    const scratch = path.dirname(scratchOf(seen[0]!));
    expect(path.basename(scratch)).toMatch(/^koala-git-/);
    expect(existsSync(scratch)).toBe(false);
    expect(seen.map((run) => run.args.filter((arg) => !arg.includes('repo.git')).join(' '))).toEqual([
      'clone --bare --quiet /tmp/b.bundle',
      '-C push --quiet --all http://gitea.test/koala-u1/shop.git',
      '-C push --quiet --tags http://gitea.test/koala-u1/shop.git',
      '-C rev-parse HEAD',
    ]);
    const failing = scripted([['push --quiet --all', { code: 1, stdout: '', stderr: 'remote: denied' }]]);
    await expect(failing.gitea.pushBundle(auth, 'koala-u1', 'shop', '/tmp/b.bundle')).rejects.toThrow('Pushing to koala-u1/shop failed: remote: denied');
    expect(existsSync(path.dirname(scratchOf(failing.seen[0]!)))).toBe(false);
  });

  it('gives git the token as an authorization header, never asks for a password and masks the token in what it reports', async () => {
    const { gitea, seen } = scripted([['push --quiet --all', { code: 1, stdout: '', stderr: 'fatal: bad token tok-secret' }]]);
    await expect(gitea.pushBundle(auth, 'koala-u1', 'shop', 'b')).rejects.toThrow('Pushing to koala-u1/shop failed: fatal: bad token ***');
    const env = seen[0]!.env!;
    const config = Object.fromEntries(Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, index): [string, string | undefined] => [String(env[`GIT_CONFIG_KEY_${index}`]), env[`GIT_CONFIG_VALUE_${index}`]]));
    expect(config).toEqual({
      'credential.helper': '', 'core.askPass': '', 'maintenance.auto': 'false', 'gc.auto': '0',
      'http.extraHeader': `Authorization: Basic ${Buffer.from('koala-u1:tok-secret').toString('base64')}`,
    });
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(Object.hasOwn(env, 'SSH_ASKPASS') && env.SSH_ASKPASS !== undefined).toBe(false);
    expect(Object.hasOwn(env, 'GIT_ASKPASS') && env.GIT_ASKPASS !== undefined).toBe(false);
  });

  it('pushes a branch from a bundle, as main too for a new repository, and answers the branch\'s commit', async () => {
    const { gitea, seen } = scripted([['rev-parse refs/heads/story', ok('def456\n')]]);
    expect(await gitea.pushBranchBundle(auth, 'koala-u1', 'shop', '/tmp/b', 'story', { asMain: true })).toBe('def456');
    expect(seen.map(said)).toEqual([
      'clone --bare --quiet /tmp/b',
      '-C push --quiet http://gitea.test/koala-u1/shop.git refs/heads/story:refs/heads/main',
      '-C push --quiet --force http://gitea.test/koala-u1/shop.git refs/heads/story:refs/heads/story',
      '-C rev-parse refs/heads/story',
    ]);
  });

  it('pulls a branch into a bundle when Gitea has it, and none when it does not', async () => {
    const present = scripted([['ls-remote --heads', ok('abc\trefs/heads/story\n')]]);
    expect(await present.gitea.pullBranchBundle(auth, 'koala-u1', 'shop', 'story', '/tmp/out.bundle')).toBe(true);
    expect(present.seen.at(-1)!.args).toEqual(['-C', scratchOf(present.seen[0]!), 'bundle', 'create', '/tmp/out.bundle', 'refs/heads/story']);
    const absent = scripted([['ls-remote --heads', ok('\n')]]);
    expect(await absent.gitea.pullBranchBundle(auth, 'koala-u1', 'shop', 'story', '/tmp/out.bundle')).toBe(false);
    expect(absent.seen.some((run) => run.args.includes('bundle'))).toBe(false);
  });

  it('pulls the whole repository into a bundle unless it is empty', async () => {
    const full = scripted([['for-each-ref', ok('abc refs/heads/main\n')]]);
    expect(await full.gitea.pullBundle(auth, 'koala-u1', 'shop', '/tmp/all.bundle')).toBe(true);
    expect(full.seen.at(-1)!.args).toEqual(['-C', scratchOf(full.seen[0]!), 'bundle', 'create', '/tmp/all.bundle', '--all']);
    const empty = scripted([['for-each-ref', ok('')]]);
    expect(await empty.gitea.pullBundle(auth, 'koala-u1', 'shop', '/tmp/all.bundle')).toBe(false);
  });

  it('diffs two commits after fetching every branch, answering git\'s output whole', async () => {
    const { gitea, seen } = scripted([['diff', ok('diff --git a/x b/x\n+1\n')]]);
    expect(await gitea.diffBetween(auth, 'koala-u1', 'shop', 'aaa', 'bbb')).toBe('diff --git a/x b/x\n+1\n');
    expect(seen.at(-1)!.args.slice(-6)).toEqual(['diff', '-M', '--no-color', '--no-ext-diff', 'aaa', 'bbb']);
    expect(seen.some((run) => run.args.includes('+refs/heads/*:refs/heads/*'))).toBe(true);
  });

  it('names the failing command when git reports no message', async () => {
    const { gitea } = scripted([['clone', { code: 128, stdout: '', stderr: '' }]]);
    await expect(gitea.pushBundle(auth, 'koala-u1', 'shop', 'b')).rejects.toThrow('Pushing to koala-u1/shop failed: git clone exited 128');
  });
});

describe('committing a drop of files from disk', () => {
  const ok = (stdout = ''): ProcessResult => ({ code: 0, stdout, stderr: '' });
  const auth = { username: 'koala-u1', token: 'tok-secret' };
  const sources = [{ path: 'README.md', source: '/drops/0' }, { path: 'public/logo.png', source: '/drops/1' }];

  function setUpDrop(steps: [words: string, answer: ProcessResult][], user: unknown = { full_name: 'Ada', email: 'ada@example.com' }) {
    const made = setUp();
    const seen: GitRun[] = [];
    made.processes.run.mockImplementation(async (run) => {
      seen.push(run);
      const said = run.args.join(' ');
      return steps.find(([words]) => said.includes(words))?.[1] ?? ok();
    });
    writeData('.gitea-admin-token', encryptValue('bot-token', KEY));
    writeData('.gitea-admin-token.scopes', JSON.stringify(ALL_SCOPES));
    server.use(
      http.get(`${BASE}/api/v1/user`, () => HttpResponse.json({})),
      http.get(`${BASE}/api/v1/users/koala-u1`, () => (user ? HttpResponse.json(user) : new HttpResponse(null, { status: 404 }))),
    );
    return { ...made, seen };
  }

  it('commits onto the default branch the remote names, as the person, hashing the files in from disk', async () => {
    const { gitea, seen } = setUpDrop([
      ['ls-remote --symref', ok('ref: refs/heads/trunk\tHEAD\n1234\tHEAD\n')],
      ['ls-remote --heads', ok('1234\trefs/heads/trunk\n')],
      ['rev-parse FETCH_HEAD', ok('parent1\n')],
      ['cat-file', ok('b1 blob 3\nparent1:public missing\nparent1:public/logo.png missing\n')],
      ['hash-object', ok('sha-a\nsha-b\n')],
      ['write-tree', ok('treesha\n')],
      ['commit-tree', ok('commit1\n')],
    ]);
    expect(await gitea.commitDropFromDisk(auth, 'koala-u1', 'shop', sources, 'Add files')).toEqual({ commit: 'commit1' });
    const byStep = (words: string) => seen.find((run) => said(run).includes(words))!;
    expect(seen.map(said)).toEqual([
      'init --quiet',
      '-C ls-remote --symref http://gitea.test/koala-u1/shop.git HEAD',
      '-C ls-remote --heads http://gitea.test/koala-u1/shop.git refs/heads/trunk',
      '-C fetch --quiet --depth 1 --no-tags http://gitea.test/koala-u1/shop.git refs/heads/trunk',
      '-C rev-parse FETCH_HEAD',
      '-C read-tree parent1',
      '-C cat-file --batch-check',
      '-C hash-object -w --no-filters --stdin-paths',
      '-C update-index --add -z --index-info',
      '-C write-tree',
      '-C commit-tree treesha -p parent1 -m Add files',
      '-C push --quiet http://gitea.test/koala-u1/shop.git commit1:refs/heads/trunk',
    ]);
    expect(byStep('cat-file').input).toBe('parent1:README.md\nparent1:public\nparent1:public/logo.png\n');
    expect(byStep('hash-object').input).toBe('/drops/0\n/drops/1\n');
    expect(byStep('update-index').input).toBe('100644 sha-a\tREADME.md\u0000100644 sha-b\tpublic/logo.png\u0000');
    expect(byStep('commit-tree').env).toMatchObject({ GIT_AUTHOR_NAME: 'Ada', GIT_AUTHOR_EMAIL: 'ada@example.com', GIT_COMMITTER_NAME: 'Ada', GIT_COMMITTER_EMAIL: 'ada@example.com' });
  });

  it('starts a new branch from the one named, leaving that one as it was', async () => {
    const { gitea, seen } = setUpDrop([
      ['ls-remote --heads', ok('1234\trefs/heads/main\n')],
      ['rev-parse FETCH_HEAD', ok('parent1\n')],
      ['hash-object', ok('sha-a\n')],
      ['commit-tree', ok('commit1\n')],
    ]);
    await gitea.commitDropFromDisk(auth, 'koala-u1', 'shop', [sources[0]!], 'm', 'main', 'drop/l1/s1');
    expect(seen.some((run) => said(run).includes('--symref'))).toBe(false);
    expect(said(seen.at(-1)!)).toBe('-C push --quiet http://gitea.test/koala-u1/shop.git commit1:refs/heads/drop/l1/s1');
  });

  it('makes a first commit with no parent into an empty repository, on main', async () => {
    const { gitea, seen } = setUpDrop([
      ['ls-remote --symref', ok('')],
      ['ls-remote --heads', ok('')],
      ['hash-object', ok('sha-a\n')],
      ['write-tree', ok('treesha\n')],
      ['commit-tree', ok('c1\n')],
    ]);
    await gitea.commitDropFromDisk(auth, 'koala-u1', 'shop', [sources[0]!], 'first');
    expect(seen.some((run) => said(run).includes('fetch'))).toBe(false);
    expect(seen.some((run) => said(run).includes('cat-file'))).toBe(false);
    expect(said(seen.find((run) => said(run).includes('commit-tree'))!)).toBe('-C commit-tree treesha -m first');
    expect(said(seen.at(-1)!)).toBe('-C push --quiet http://gitea.test/koala-u1/shop.git c1:refs/heads/main');
  });

  it('uses the login when the person has no name or address on Gitea', async () => {
    const { gitea, seen } = setUpDrop([['ls-remote --heads', ok('')], ['commit-tree', ok('c\n')]], { full_name: '', email: '' });
    await gitea.commitDropFromDisk(auth, 'koala-u1', 'shop', [sources[0]!], 'm');
    expect(seen.find((run) => said(run).includes('commit-tree'))!.env).toMatchObject({ GIT_AUTHOR_NAME: 'koala-u1', GIT_AUTHOR_EMAIL: 'koala-u1@noreply.localhost' });
  });

  it('refuses when the person cannot be looked up, before any git runs', async () => {
    const { gitea, seen } = setUpDrop([], null);
    await expect(gitea.commitDropFromDisk(auth, 'koala-u1', 'shop', sources, 'm')).rejects.toThrow('Could not look up the user koala-u1: HTTP 404');
    expect(seen).toEqual([]);
  });

  it('refuses a branch that is not there', async () => {
    const { gitea } = setUpDrop([['ls-remote --heads', ok('')]]);
    await expect(gitea.commitDropFromDisk(auth, 'koala-u1', 'shop', sources, 'm', 'gone')).rejects.toThrow('Committing to koala-u1/shop failed: there is no branch gone');
  });

  it('refuses a file where the repository has a folder, and a file under a file, as a conflict, committing nothing', async () => {
    const folder = setUpDrop([['ls-remote --heads', ok('1\trefs/heads/main\n')], ['rev-parse FETCH_HEAD', ok('p\n')], ['cat-file', ok('x tree 0\n')]]);
    const error = await folder.gitea.commitDropFromDisk(auth, 'koala-u1', 'shop', [{ path: 'docs', source: '/d/0' }], 'm', 'main').catch((err: unknown) => err);
    expect(error).toBeInstanceOf(GiteaConflictError);
    expect((error as Error).message).toBe('"docs" is a folder in "koala-u1/shop", so a file cannot go there.');
    expect(folder.seen.some((run) => said(run).includes('push'))).toBe(false);
    const file = setUpDrop([['ls-remote --heads', ok('1\trefs/heads/main\n')], ['rev-parse FETCH_HEAD', ok('p\n')], ['cat-file', ok('x blob 3\nx missing\n')]]);
    await expect(file.gitea.commitDropFromDisk(auth, 'koala-u1', 'shop', [{ path: 'README.md/x', source: '/d/0' }], 'm', 'main')).rejects.toThrow('"README.md" is a file in "koala-u1/shop", so "README.md/x" cannot go under it.');
  });

  it('tells the person to drop again when the push loses a race, and reports any other push failure with the token masked', async () => {
    const raced = setUpDrop([['ls-remote --heads', ok('1\trefs/heads/main\n')], ['hash-object', ok('a\n')], ['push', { code: 1, stdout: '', stderr: ' ! [rejected] main -> main (fetch first)' }]]);
    await expect(raced.gitea.commitDropFromDisk(auth, 'koala-u1', 'shop', [sources[0]!], 'm', 'main', 'drop/x')).rejects.toThrow(GiteaConflictError);
    const broken = setUpDrop([['hash-object', ok('a\n')], ['push', { code: 1, stdout: '', stderr: 'fatal: unable to access with tok-secret' }]]);
    await expect(broken.gitea.commitDropFromDisk(auth, 'koala-u1', 'shop', [sources[0]!], 'm')).rejects.toThrow('Committing to koala-u1/shop failed: fatal: unable to access with ***');
  });
});

describe('landing a story\'s branch on main', () => {
  const REPO = `${BASE}/api/v1/repos/koala-bo/shop`;
  const yes: ProcessResult = { code: 0, stdout: '', stderr: '' };
  const not: ProcessResult = { code: 1, stdout: '', stderr: '' };

  function landing(git: { already?: boolean; conflict?: boolean; fails?: string } = {}) {
    const { gitea, processes } = setUp();
    vi.spyOn(gitea as unknown as { getToken(): Promise<string> }, 'getToken').mockResolvedValue('bot-token');
    const runs: string[] = [];
    processes.run.mockImplementation(async (run) => {
      const own = run.args.slice(2);
      runs.push(own[0] ?? '');
      if (own[0] === 'rev-parse') return { ...yes, stdout: own[1] === 'refs/koala/base' ? 'b'.repeat(40) : 'h'.repeat(40) };
      if (own[0] === 'merge-base') return own[2] === 'h'.repeat(40) ? (git.already ? yes : not) : (git.conflict ? not : yes);
      if (own[0] === 'merge-tree') return { code: 1, stdout: `${'t'.repeat(40)}\nREADME.md\n`, stderr: '' };
      if (own[0] === 'push' && git.fails) return { code: 128, stdout: '', stderr: git.fails };
      return yes;
    });
    const seen: string[] = [];
    const record = (what: string) => async ({ request }: { request: Request }) => { seen.push(`${what} ${request.method === 'GET' ? '' : await request.text()}`.trim()); };
    return { gitea, runs, seen, record };
  }

  it('opens a pull request as the record, lands the branch with git, then marks the pull request merged at the commit that landed', async () => {
    const { gitea, runs, seen, record } = landing();
    server.use(
      http.get(`${REPO}/pulls`, async (info) => { await record('list')(info); return HttpResponse.json([]); }),
      http.post(`${REPO}/pulls`, async (info) => { await record('open')(info); return HttpResponse.json({ number: 7 }); }),
      http.patch(REPO, async (info) => { await record('repo')(info); return HttpResponse.json({}); }),
      http.post(`${REPO}/pulls/7/merge`, async (info) => { await record('mark')(info); return HttpResponse.json({}); }),
    );
    expect(await gitea.mergeBranch('koala-bo', 'shop', 'leaf/l1', 'main', { title: 'Land Checkout', body: 'Goal: pay' })).toBe('merged');
    expect(seen).toEqual(['list', 'open {"head":"leaf/l1","base":"main","title":"Land Checkout","body":"Goal: pay"}', 'repo {"allow_manual_merge":true}', `mark {"Do":"manually-merged","MergeCommitID":"${'h'.repeat(40)}"}`]);
    expect(runs).toContain('push');
  });

  it('lands through the pull request already open, and lands even when Gitea will not record it merged, saying so', async () => {
    const { gitea, seen, record } = landing();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    server.use(
      http.get(`${REPO}/pulls`, () => HttpResponse.json([{ number: 3, head: { ref: 'leaf/l1' }, base: { ref: 'main' } }])),
      http.post(`${REPO}/pulls`, async (info) => { await record('open')(info); return HttpResponse.json({ number: 9 }); }),
      http.patch(REPO, () => HttpResponse.json({ message: 'not allowed' }, { status: 403 })),
      http.post(`${REPO}/pulls/3/merge`, () => HttpResponse.json({ message: 'not allowed' }, { status: 405 })),
    );
    expect(await gitea.mergeBranch('koala-bo', 'shop', 'leaf/l1', 'main')).toBe('merged');
    expect(seen).toEqual([]);
    expect(warn).toHaveBeenCalledWith(containing('koala-bo/shop will not let its pull requests be marked merged (HTTP 403)'));
    expect(warn).toHaveBeenCalledWith(containing('its pull request #3 was not marked merged (HTTP 405)'));
  });

  it('lands through the pull request another landing opened between its look and its open, and fails when that one cannot be found', async () => {
    let looked = 0;
    const found = [[], [{ number: 4, head: { ref: 'leaf/l1' }, base: { ref: 'main' } }]];
    server.use(
      http.get(`${REPO}/pulls`, () => HttpResponse.json(found[Math.min(looked++, 1)])),
      http.post(`${REPO}/pulls`, () => HttpResponse.json({ message: 'pull request already exists for these targets' }, { status: 409 })),
      http.patch(REPO, () => HttpResponse.json({})),
      http.post(`${REPO}/pulls/4/merge`, () => HttpResponse.json({})),
    );
    expect(await landing().gitea.mergeBranch('koala-bo', 'shop', 'leaf/l1', 'main')).toBe('merged');
    server.use(http.get(`${REPO}/pulls`, () => HttpResponse.json([])));
    const { gitea, runs } = landing();
    expect(await gitea.mergeBranch('koala-bo', 'shop', 'leaf/l1', 'main')).toBe('failed');
    expect(runs).toEqual([]);
  });

  it('says there is nothing to land when Gitea finds no difference, running no git', async () => {
    const { gitea, runs } = landing();
    server.use(
      http.get(`${REPO}/pulls`, () => HttpResponse.json([])),
      http.post(`${REPO}/pulls`, () => HttpResponse.json({ message: 'There are no changes: nothing to compare' }, { status: 422 })),
    );
    expect(await gitea.mergeBranch('koala-bo', 'shop', 'leaf/l1', 'main')).toBe('nothing');
    expect(runs).toEqual([]);
  });

  it('closes the pull request of a branch main already holds, and says there was nothing to land', async () => {
    const { gitea, runs, seen, record } = landing({ already: true });
    server.use(
      http.get(`${REPO}/pulls`, () => HttpResponse.json([{ number: 3, head: { ref: 'leaf/l1' }, base: { ref: 'main' } }])),
      http.patch(REPO, () => HttpResponse.json({})),
      http.patch(`${REPO}/pulls/3`, async (info) => { await record('close')(info); return HttpResponse.json({}); }),
    );
    expect(await gitea.mergeBranch('koala-bo', 'shop', 'leaf/l1', 'main')).toBe('nothing');
    expect(seen).toEqual(['close {"state":"closed"}']);
    expect(runs).not.toContain('push');
  });

  it('answers a conflict, and a failure without the bot\'s token in what it logs', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const handlers = [http.get(`${REPO}/pulls`, () => HttpResponse.json([{ number: 3, head: { ref: 'leaf/l1' }, base: { ref: 'main' } }])), http.patch(REPO, () => HttpResponse.json({}))];
    server.use(...handlers);
    expect(await landing({ conflict: true }).gitea.mergeBranch('koala-bo', 'shop', 'leaf/l1', 'main')).toBe('conflict');
    expect(warn).toHaveBeenCalledWith(containing('conflicts with koala-bo/shop main in README.md'));
    expect(await landing({ fails: 'fatal: could not read from bot-token@gitea' }).gitea.mergeBranch('koala-bo', 'shop', 'leaf/l1', 'main')).toBe('failed');
    const said = warn.mock.calls.map(([line]) => String(line)).join('\n');
    expect(said).toContain('leaf/l1 did not land on koala-bo/shop main');
    expect(said).not.toContain('bot-token');
  });
});

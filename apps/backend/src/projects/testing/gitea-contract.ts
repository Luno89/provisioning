import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { InfrastructureService } from '../../infrastructure/index.js';
import { mainHeads, syncMain } from '../../hub/services/HubRepoSync.js';
import { giteaHubRepos, HUB_REPO, hubBotOf, hubOrgOf } from '../../hub/services/HubRepos.js';
import { GiteaConflictError, GiteaService } from '../services/GiteaService.js';

const run = promisify(execFile);
const KEY = 'gitea-contract-test-key' as never;
const ADMIN = 'provisioning-bot';

export interface ContractGitea {
  url: string;
  adminPassword: string;
  unhandled: string[];
  close(): Promise<void>;
}

interface Heard { body: Buffer; signature: string | undefined; event: string | undefined }
interface Pushed { ref: string; before: string; after: string; commits: { id: string; message: string; added: string[]; modified: string[]; removed: string[] }[]; repository: { full_name: string } }

const basic = (user: string, secret: string): string => `Basic ${Buffer.from(`${user}:${secret}`).toString('base64')}`;
const quietGit = { PATH: process.env.PATH, HOME: tmpdir(), GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Contract', GIT_AUTHOR_EMAIL: 'contract@koala.test', GIT_COMMITTER_NAME: 'Contract', GIT_COMMITTER_EMAIL: 'contract@koala.test' };

async function waitFor<T>(look: () => T | undefined | Promise<T | undefined>): Promise<T> {
  for (;;) {
    const found = await look();
    if (found !== undefined) return found;
    await new Promise((done) => setTimeout(done, 50));
  }
}

export function giteaContract(start: () => Promise<ContractGitea>): void {
  let gitea: ContractGitea;
  let service: GiteaService;
  let dataDir: string;
  let scratch: string;
  let saved: string | undefined;
  let hooks: http.Server;
  let hookUrl: string;
  const heard: Heard[] = [];
  let annPassword = '';

  const api = async (method: string, route: string, auth: string | undefined, body?: unknown): Promise<{ status: number; body: unknown }> => {
    const answer = await fetch(`${gitea.url}/api/v1${route}`, {
      method,
      headers: { ...(auth ? { Authorization: auth } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await answer.text();
    return { status: answer.status, body: (answer.headers.get('content-type') ?? '').includes('json') ? JSON.parse(text) as unknown : text };
  };
  const asAdmin = (): string => basic(ADMIN, gitea.adminPassword);
  const pushes = (): Pushed[] => heard.filter((hook) => hook.event === 'push').map((hook) => JSON.parse(hook.body.toString('utf8')) as Pushed);
  const pushTo = (full: string, after: string): Promise<Pushed> => waitFor(() => pushes().find((push) => push.repository.full_name === full && push.after === after));
  const git = (args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) => run('git', args, { cwd: options.cwd ?? scratch, env: { ...quietGit, ...options.env } }).then(({ stdout }) => stdout);
  const work = async (name: string, files: Record<string, string>, branch = 'main'): Promise<{ dir: string; bundle: string }> => {
    const dir = path.join(scratch, name);
    await git(['init', '--quiet', `--initial-branch=${branch}`, dir]);
    for (const [file, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
      await writeFile(path.join(dir, file), content);
    }
    await git(['add', '-A'], { cwd: dir });
    await git(['commit', '--quiet', '-m', `Work in ${name}`], { cwd: dir });
    const bundle = path.join(scratch, `${name}.bundle`);
    await git(['bundle', 'create', bundle, '--all'], { cwd: dir });
    return { dir, bundle };
  };

  beforeAll(async () => {
    gitea = await start();
    saved = process.env.GITEA_URL;
    process.env.GITEA_URL = gitea.url;
    dataDir = await mkdtemp(path.join(tmpdir(), 'gitea-contract-data-'));
    scratch = await mkdtemp(path.join(tmpdir(), 'gitea-contract-work-'));
    await writeFile(path.join(dataDir, '.gitea-admin-password'), gitea.adminPassword);
    const infra = mock<Pick<InfrastructureService, 'runKubectl' | 'getK3dServerIp'>>();
    infra.runKubectl.mockRejectedValue(new Error('no cluster here'));
    service = new GiteaService(infra, KEY, '/nowhere', { dataDir });
    hooks = http.createServer((req, res) => {
      const parts: Buffer[] = [];
      req.on('data', (part: Buffer) => parts.push(part));
      req.on('end', () => {
        heard.push({ body: Buffer.concat(parts), signature: req.headers['x-gitea-signature'] as string | undefined, event: req.headers['x-gitea-event'] as string | undefined });
        res.writeHead(202).end();
      });
    });
    await new Promise<void>((done) => hooks.listen(0, '127.0.0.1', done));
    hookUrl = `http://127.0.0.1:${(hooks.address() as AddressInfo).port}/hook`;
  });

  afterAll(async () => {
    if (saved === undefined) delete process.env.GITEA_URL; else process.env.GITEA_URL = saved;
    await new Promise<void>((done) => hooks.close(() => done()));
    await gitea.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  });

  describe('Gitea, as GiteaService and the hub drive it', { timeout: 0 }, () => {
    it('refuses anyone who does not sign in, over the API, the registry and git', async () => {
      expect(await api('GET', `/users/${ADMIN}`, undefined)).toMatchObject({ status: 403, body: { message: 'Only signed in user is allowed to call APIs.' } });
      expect((await api('GET', '/user', basic(ADMIN, 'not-the-password'))).status).toBe(401);
      expect((await fetch(`${gitea.url}/v2/`)).status).toBe(401);
      expect((await fetch(`${gitea.url}/v2/`, { headers: { Authorization: asAdmin() } })).status).toBe(200);
    });

    it('makes a person\'s account once, and says who exists', async () => {
      annPassword = (await service.createUserAccount('ann', 'ann@koala.local')).password;
      await expect(service.createUserAccount('ann', 'ann@koala.local')).rejects.toThrow(/HTTP 422/);
      expect(await service.userExists('ann')).toBe(true);
      expect(await service.userExists('nobody')).toBe(false);
      expect(await api('GET', '/user', basic('ann', annPassword))).toMatchObject({ status: 200, body: { login: 'ann', is_admin: false } });
    });

    it('mints tokens by password, scoped to what they were made for, lists the bot\'s build tokens and revokes them', async () => {
      const push = await service.createPushToken('ann', annPassword);
      const read = await service.createReadToken('ann', annPassword);
      expect(push.name).toMatch(/^koala-run-/);
      expect(read.name).toMatch(/^koala-mcp-/);
      expect(await api('POST', '/users/ann/tokens', basic('ann', annPassword), { name: push.name, scopes: ['write:repository'] })).toMatchObject({ status: 400, body: { message: 'access token name has been used already' } });
      expect(await api('GET', '/user', `token ${read.token}`)).toMatchObject({ status: 200, body: { login: 'ann' } });
      expect((await api('GET', '/user', `token ${push.token}`)).status).toBe(403);
      expect((await api('GET', '/admin/users', `token ${push.token}`)).status).toBe(403);
      expect((await api('POST', '/users/ann/tokens', `token ${push.token}`, { name: 'by-token', scopes: ['write:repository'] })).status).toBe(403);
      await service.revokeUserToken('ann', annPassword, read.name);
      await service.revokeUserToken('ann', annPassword, read.name);
      expect((await api('GET', '/user', `token ${read.token}`)).status).toBe(401);

      const first = await service.createDeployToken();
      const second = await service.createDeployToken();
      expect(await service.buildTokenNames()).toEqual(expect.arrayContaining([first.name, second.name]));
      await service.revokeToken(first.name);
      await service.revokeToken(first.name);
      const left = await service.buildTokenNames();
      expect(left).toContain(second.name);
      expect(left).not.toContain(first.name);
      expect((await fetch(`${gitea.url}/v2/`, { headers: { Authorization: basic(ADMIN, second.token) } })).status).toBe(200);
      const login = await service.registryLogin();
      expect(login.username).toBe(ADMIN);
      expect((await fetch(`${gitea.url}/v2/`, { headers: { Authorization: basic(ADMIN, login.password) } })).status).toBe(200);
      expect((await fetch(`${gitea.url}/v2/`, { headers: { Authorization: basic(ADMIN, first.token) } })).status).toBe(401);
    });

    it('changes a password, after which only the new one signs in', async () => {
      const next = `${annPassword}-next`;
      await service.setUserPassword('ann', next);
      expect((await api('GET', '/user', basic('ann', annPassword))).status).toBe(401);
      expect((await api('GET', '/user', basic('ann', next))).status).toBe(200);
      annPassword = next;
    });

    it('makes every account private, once', async () => {
      expect((await api('POST', '/admin/users', asAdmin(), { username: 'pub', email: 'pub@koala.local', password: 'a-long-password-1', must_change_password: false, visibility: 'public' })).status).toBe(201);
      expect(await service.makeUsersPrivate()).toEqual(['pub']);
      expect(await service.makeUsersPrivate()).toEqual([]);
      expect(await service.deleteUser('pub')).toBe(true);
    });

    it('makes a person\'s repository started with a README and a .gitignore, read back file by file', async () => {
      const made = await service.createRepoForUser('ann', 'shop', { private: true, description: 'The shop' });
      expect(made).toEqual({ fullName: 'ann/shop', cloneUrl: `${gitea.url}/ann/shop.git` });
      await expect(service.createRepoForUser('ann', 'shop', { private: true })).rejects.toThrow(/HTTP 409/);
      expect(await service.findRepo('ann', 'shop')).toEqual({ owner: 'ann', name: 'shop' });
      expect(await service.findRepo('ann', 'other')).toBeNull();
      expect((await service.listPaths('ann', 'shop', 'main')).sort()).toEqual(['.gitignore', 'README.md']);
      expect(await service.getRawFile('ann', 'shop', 'README.md', 'main')).toBe('# shop\n\nThe shop');
      expect(await service.getRawFile('ann', 'shop', 'README.md')).toBe('# shop\n\nThe shop');
      expect(await service.getRawFile('ann', 'shop', 'missing.md', 'main')).toBeNull();
      expect(await service.repoServesFiles('ann', 'shop')).toBe(true);
      expect(await service.listPaths('ann', 'shop', 'no-such-branch')).toEqual([]);
      expect(await service.pullRequests('ann', 'shop')).toEqual([]);
    });

    it('makes an empty repository that serves nothing, and one of the bot\'s own', async () => {
      expect(await service.createRepoForUser('ann', 'blank', { empty: true })).toEqual({ fullName: 'ann/blank', cloneUrl: `${gitea.url}/ann/blank.git` });
      expect(await service.repoServesFiles('ann', 'blank')).toBe(false);
      expect(await service.listPaths('ann', 'blank', 'main')).toEqual([]);
      expect(await service.getRawFile('ann', 'blank', 'README.md', 'main')).toBeNull();
      expect(await service.inspectBranch('ann', 'blank', 'main', ['README.md'])).toEqual({ exists: false, found: [], missing: ['README.md'] });
      const own = await service.createRepo('tools');
      expect(own).toEqual({ owner: ADMIN, name: 'tools', cloneUrl: `${gitea.url}/${ADMIN}/tools.git` });
      expect((await service.listPaths(ADMIN, 'tools', 'main')).sort()).toEqual(['README.md']);
      await service.deleteRepo(ADMIN, 'tools');
      await service.deleteRepo(ADMIN, 'tools');
      expect(await service.findRepo(ADMIN, 'tools')).toBeNull();
    });

    it('keeps one webhook per address, signed with its secret, and tells it every push to main', async () => {
      await service.replaceWebhook('ann', 'shop', hookUrl, 'hook-secret');
      await service.replaceWebhook('ann', 'shop', hookUrl, 'hook-secret');
      const listed = await api('GET', '/repos/ann/shop/hooks', asAdmin());
      expect(listed.status).toBe(200);
      expect(listed.body).toMatchObject([{ type: 'gitea', active: true, events: ['push'], config: { url: hookUrl, content_type: 'json' } }]);
      const first = await service.putFile('ann', 'shop', 'notes.txt', 'one\n', 'Add notes', 'main');
      expect(first.changed).toBe(true);
      expect(await service.putFile('ann', 'shop', 'notes.txt', 'one\n', 'Again', 'main')).toEqual({ changed: false });
      const pushed = await pushTo('ann/shop', first.commit!);
      expect(pushed).toMatchObject({ ref: 'refs/heads/main', after: first.commit, commits: [{ id: first.commit, message: 'Add notes\n', added: ['notes.txt'], modified: [], removed: [] }] });
      const hook = heard.find((entry) => entry.event === 'push' && (JSON.parse(entry.body.toString('utf8')) as Pushed).after === first.commit)!;
      expect(service.verifyWebhookSignature(hook.body, hook.signature, 'hook-secret')).toBe(true);
      const second = await service.putFile('ann', 'shop', 'notes.txt', 'two\n', 'Change notes', 'main');
      expect(await pushTo('ann/shop', second.commit!)).toMatchObject({ before: first.commit, commits: [{ message: 'Change notes\n', added: [], modified: ['notes.txt'], removed: [] }] });
      expect(await service.getRawFile('ann', 'shop', 'notes.txt', 'main')).toBe('two\n');
      expect(pushes().filter((push) => push.after === first.commit)).toHaveLength(1);
      const id = (listed.body as { id: number }[])[0]!.id;
      expect((await api('DELETE', `/repos/ann/shop/hooks/${id + 1000}`, asAdmin())).status).toBe(404);
    });

    it('moves a webhook to a new address for the same path, leaving one hook', async () => {
      const elsewhere = hookUrl.replace('127.0.0.1', 'localhost');
      await service.replaceWebhook('ann', 'shop', elsewhere, 'hook-secret');
      expect(((await api('GET', '/repos/ann/shop/hooks', asAdmin())).body as { config: { url: string } }[]).map((hook) => hook.config.url)).toEqual([elsewhere]);
      await service.replaceWebhook('ann', 'shop', hookUrl, 'hook-secret');
      expect(((await api('GET', '/repos/ann/shop/hooks', asAdmin())).body as { config: { url: string } }[]).map((hook) => hook.config.url)).toEqual([hookUrl]);
    });

    it('reads a commit by its id', async () => {
      const head = (await api('GET', '/repos/ann/shop/branches/main', asAdmin())).body as { name: string; commit: { id: string } };
      expect(head.name).toBe('main');
      const commit = await service.getCommit('ann', 'shop', head.commit.id);
      expect(commit).toMatchObject({ message: 'Change notes\n', author: ADMIN });
      expect(Object.keys(commit!).sort()).toEqual(['author', 'date', 'message']);
      expect(commit!.date).toMatch(/^\d{4}-\d\d-\d\dT/);
      expect(await service.getCommit('ann', 'shop', '0123456789abcdef0123456789abcdef01234567')).toBeNull();
    });

    it('writes files only where they are not, in one commit or one by one, and says what a branch holds', async () => {
      expect(await service.ensureFile('ann', 'shop', 'notes.txt', 'other\n', 'Again')).toBe(false);
      expect(await service.ensureFile('ann', 'shop', 'docs/guide.md', '# Guide\n', 'Add the guide')).toBe(true);
      expect(await service.seedTemplate('ann', 'shop', [{ path: 'notes.txt', content: 'x' }, { path: 'src/app.ts', content: 'export {};\n' }, { path: 'src/lib/util.ts', content: 'export const a = 1;\n' }])).toEqual(['src/app.ts', 'src/lib/util.ts']);
      expect(await service.seedTemplate('ann', 'shop', [{ path: 'src/app.ts', content: 'other' }])).toEqual([]);
      await service.commitFiles('ann', 'shop', [{ path: 'src/app.ts', content: 'export const app = 1;\n' }, { path: 'src/new.ts', content: 'new\n' }], 'Change the app');
      expect(await service.getRawFile('ann', 'shop', 'src/app.ts', 'main')).toBe('export const app = 1;\n');
      expect(await service.getRawFile('ann', 'shop', 'src/new.ts', 'main')).toBe('new\n');
      expect((await service.listPaths('ann', 'shop', 'main')).sort()).toEqual(['.gitignore', 'README.md', 'docs/guide.md', 'notes.txt', 'src/app.ts', 'src/lib/util.ts', 'src/new.ts']);
      const hashes = await service.fileHashes('ann', 'shop', 'main');
      expect([...hashes.keys()].sort()).toEqual(['.gitignore', 'README.md', 'docs/guide.md', 'notes.txt', 'src/app.ts', 'src/lib/util.ts', 'src/new.ts']);
      const tree = (await api('GET', '/repos/ann/shop/git/trees/main?recursive=true&per_page=10000', asAdmin())).body as { tree: { path: string; type: string; size?: number }[]; truncated: boolean };
      expect(tree.truncated).toBe(false);
      expect(tree.tree.filter((entry) => entry.type === 'tree').map((entry) => entry.path).sort()).toEqual(['docs', 'src', 'src/lib']);
      expect(tree.tree.find((entry) => entry.path === 'notes.txt')).toMatchObject({ type: 'blob', size: 4 });
      expect(await service.inspectBranch('ann', 'shop', 'main', ['notes.txt', 'missing.txt', 'src'])).toEqual({ exists: true, found: ['notes.txt'], missing: ['missing.txt', 'src'] });
      expect(await service.inspectBranch('ann', 'shop', 'no-such-branch', ['notes.txt'])).toEqual({ exists: false, found: [], missing: ['notes.txt'] });
    });

    it('lists folders, reads, updates and deletes a file as the person, refusing a stale one', async () => {
      const { token } = await service.createPushToken('ann', annPassword);
      expect(await service.listDirectory(token, 'ann', 'shop', '')).toEqual([
        { path: '.gitignore', name: '.gitignore', type: 'file', size: Buffer.byteLength((await service.getRawFile('ann', 'shop', '.gitignore'))!) },
        { path: 'README.md', name: 'README.md', type: 'file', size: 16 },
        { path: 'docs', name: 'docs', type: 'dir', size: 0 },
        { path: 'notes.txt', name: 'notes.txt', type: 'file', size: 4 },
        { path: 'src', name: 'src', type: 'dir', size: 0 },
      ]);
      expect(await service.listDirectory(token, 'ann', 'shop', 'src', 'main')).toEqual([
        { path: 'src/app.ts', name: 'app.ts', type: 'file', size: 22 },
        { path: 'src/lib', name: 'lib', type: 'dir', size: 0 },
        { path: 'src/new.ts', name: 'new.ts', type: 'file', size: 4 },
      ]);
      expect(await service.listDirectory(token, 'ann', 'shop', 'notes.txt')).toEqual([{ path: 'notes.txt', name: 'notes.txt', type: 'file', size: 4 }]);
      expect(await service.listDirectory(token, 'ann', 'shop', 'nowhere')).toEqual([]);
      const read = await service.getFileContent(token, 'ann', 'shop', 'notes.txt', 'main');
      expect(read).toEqual({ path: 'notes.txt', content: 'two\n', sha: (await service.fileHashes('ann', 'shop', 'main')).get('notes.txt') });
      expect(await service.getFileContent(token, 'ann', 'shop', 'missing.txt')).toBeNull();
      await expect(service.getFileContent(token, 'ann', 'shop', 'src')).rejects.toThrow(/is a directory/);
      const updated = await service.updateFile(token, 'ann', 'shop', 'notes.txt', 'three\n', 'Three', read!.sha, 'main');
      expect(updated.sha).toBe((await service.fileHashes('ann', 'shop', 'main')).get('notes.txt'));
      await expect(service.updateFile(token, 'ann', 'shop', 'notes.txt', 'four\n', 'Four', read!.sha, 'main')).rejects.toBeInstanceOf(GiteaConflictError);
      await expect(service.updateFile(token, 'ann', 'shop', 'nowhere.txt', 'four\n', 'Four', read!.sha)).rejects.toThrow(/HTTP 404/);
      await expect(service.deleteFile(token, 'ann', 'shop', 'notes.txt', 'Drop', read!.sha)).rejects.toBeInstanceOf(GiteaConflictError);
      expect(await service.getRawFile('ann', 'shop', 'notes.txt', 'main')).toBe('three\n');
      await service.deleteFile(token, 'ann', 'shop', 'notes.txt', 'Drop', updated.sha, 'main');
      expect(await service.getRawFile('ann', 'shop', 'notes.txt', 'main')).toBeNull();
      await expect(service.deleteFile(token, 'ann', 'shop', 'notes.txt', 'Drop', updated.sha)).rejects.toThrow(/HTTP 404/);
      expect(await service.putFile('ann', 'shop', 'notes.txt', 'back\n', 'Back', 'main')).toMatchObject({ changed: true });
    });

    it('takes git over http only from someone signed in, by password or a token with the right scope', async () => {
      const url = await service.repoGitUrl('ann', 'shop');
      const ls = (env: NodeJS.ProcessEnv = {}) => git(['ls-remote', '--heads', url], { env }).then((out) => out, (err: Error) => err);
      const header = (user: string, secret: string) => ({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: ${basic(user, secret)}` });
      expect(await ls()).toBeInstanceOf(Error);
      expect(await ls(header('ann', 'wrong-password'))).toBeInstanceOf(Error);
      expect(await ls(header('ann', annPassword))).toMatch(/refs\/heads\/main/);
      const deploy = await service.createDeployToken();
      expect(await ls(header(ADMIN, deploy.token))).toMatch(/refs\/heads\/main/);
      const stranger = await service.createUserAccount('zed', 'zed@koala.local');
      expect(await ls(header('zed', stranger.password))).toBeInstanceOf(Error);
      expect((await api('GET', '/repos/ann/shop', basic('zed', stranger.password))).status).toBe(404);
      expect(await service.deleteUser('zed')).toBe(true);
      await service.revokeToken(deploy.name);
    });

    it('pushes and fetches bundles, branches with slashes, diffs and drops, and deletes a branch', async () => {
      const auth = { username: 'ann', token: (await service.createPushToken('ann', annPassword)).token };
      const fresh = await work('fresh', { 'a.txt': 'a\n', 'dir/b.txt': 'b\n' });
      await service.createRepoForUser('ann', 'bundled', { empty: true });
      const head = await service.pushBundle(auth, 'ann', 'bundled', fresh.bundle);
      expect(head).toBe((await git(['rev-parse', 'HEAD'], { cwd: fresh.dir })).trim());
      expect((await service.listPaths('ann', 'bundled', 'main')).sort()).toEqual(['a.txt', 'dir/b.txt']);
      await waitFor(async () => ((await service.repoServesFiles('ann', 'bundled')) ? true : undefined));
      const back = path.join(scratch, 'back.bundle');
      expect(await service.pullBundle(auth, 'ann', 'bundled', back)).toBe(true);
      expect(await service.pullBundle(auth, 'ann', 'blank', path.join(scratch, 'blank.bundle'))).toBe(false);

      await git(['checkout', '--quiet', '-b', 'feature/x'], { cwd: fresh.dir });
      await writeFile(path.join(fresh.dir, 'a.txt'), 'changed\n');
      await git(['commit', '--quiet', '-am', 'Change a'], { cwd: fresh.dir });
      const branchBundle = path.join(scratch, 'feature.bundle');
      await git(['bundle', 'create', branchBundle, 'refs/heads/feature/x'], { cwd: fresh.dir });
      const tip = await service.pushBranchBundle(auth, 'ann', 'bundled', branchBundle, 'feature/x');
      expect(tip).toBe((await git(['rev-parse', 'HEAD'], { cwd: fresh.dir })).trim());
      expect(await service.inspectBranch('ann', 'bundled', 'feature/x', ['a.txt'])).toEqual({ exists: true, found: ['a.txt'], missing: [] });
      expect(await service.getRawFile('ann', 'bundled', 'a.txt', 'feature/x')).toBe('changed\n');
      expect(await service.diffBetween(auth, 'ann', 'bundled', 'main', 'feature/x')).toMatch(/^diff --git a\/a\.txt b\/a\.txt[\s\S]*-a\n\+changed\n$/);
      expect(await service.pullBranchBundle(auth, 'ann', 'bundled', 'feature/x', path.join(scratch, 'pulled.bundle'))).toBe(true);
      expect(await service.pullBranchBundle(auth, 'ann', 'bundled', 'feature/none', path.join(scratch, 'none.bundle'))).toBe(false);

      const source = path.join(scratch, 'dropped.txt');
      await writeFile(source, Buffer.from([0, 1, 2, 255]));
      const dropped = await service.commitDropFromDisk(auth, 'ann', 'bundled', [{ path: 'drop/bytes.bin', source }], 'Drop bytes');
      expect((await service.fileHashes('ann', 'bundled', 'main')).get('drop/bytes.bin')).toBe((await git(['hash-object', source])).trim());
      expect((await api('GET', `/repos/ann/bundled/git/commits/${dropped.commit}`, asAdmin())).status).toBe(200);
      await expect(service.commitDropFromDisk(auth, 'ann', 'bundled', [{ path: 'drop/bytes.bin/inner', source }], 'Under a file')).rejects.toBeInstanceOf(GiteaConflictError);
      const onBranch = await service.commitDropFromDisk(auth, 'ann', 'bundled', [{ path: 'b2.txt', source }], 'On a branch', 'main', 'drop/one');
      expect(await service.inspectBranch('ann', 'bundled', 'drop/one', ['b2.txt'])).toEqual({ exists: true, found: ['b2.txt'], missing: [] });
      expect(onBranch.commit).toMatch(/^[0-9a-f]{40}$/);

      await service.deleteBranch('ann', 'bundled', 'feature/x');
      await service.deleteBranch('ann', 'bundled', 'feature/x');
      expect((await api('GET', '/repos/ann/bundled/branches/feature/x', asAdmin())).status).toBe(404);
      expect(await service.pullBranchBundle(auth, 'ann', 'bundled', 'feature/x', path.join(scratch, 'gone.bundle'))).toBe(false);
    });

    it('keeps a shared project\'s repository in an organisation its bot pushes to, synced with the owner\'s main, and removes it all', async () => {
      const repos = giteaHubRepos(service, { url: async () => hookUrl, secret: () => 'hub-secret' });
      const access = await repos.create('p1');
      expect(await service.findRepo(hubOrgOf('p1'), HUB_REPO)).not.toBeNull();
      expect(await service.repoServesFiles(hubOrgOf('p1'), HUB_REPO)).toBe(false);
      await service.ensureOrg(hubOrgOf('p1'));
      await service.ensureOrgRepo(hubOrgOf('p1'), HUB_REPO);
      await expect(service.letWrite(hubOrgOf('p1'), HUB_REPO, 'nobody')).rejects.toThrow(/HTTP 422/);
      expect(access.username).toBe(hubBotOf('p1'));
      const admin = await service.getAdminCredentials();
      const owner = { url: await service.repoGitUrl('ann', 'shop'), auth: { username: admin.username, token: admin.password } };
      const hub = { url: access.url, auth: { username: access.username, token: access.token } };
      expect((await syncMain(owner, hub, () => 'kept')).outcome).toBe('to-hub');
      const heads = await mainHeads(owner, hub);
      expect(heads.owner).toBeTruthy();
      expect(heads.hub).toBe(heads.owner);
      const pushed = await pushTo(`${hubOrgOf('p1')}/${HUB_REPO}`, heads.hub!);
      const hook = heard.find((entry) => entry.event === 'push' && (JSON.parse(entry.body.toString('utf8')) as Pushed).after === pushed.after && (JSON.parse(entry.body.toString('utf8')) as Pushed).repository.full_name === pushed.repository.full_name)!;
      expect(service.verifyWebhookSignature(hook.body, hook.signature, 'hub-secret')).toBe(true);
      expect((await repos.files('p1')).sort()).toEqual(['.gitignore', 'README.md', 'docs/guide.md', 'notes.txt', 'src/app.ts', 'src/lib/util.ts', 'src/new.ts']);
      expect(await repos.read('p1', 'notes.txt')).toBe('back\n');
      expect(await repos.read('p1', 'src/lib/util.ts')).toBe('export const a = 1;\n');
      const refused = await api('DELETE', `/orgs/${hubOrgOf('p1')}`, asAdmin());
      expect(refused.status).toBe(500);
      expect((refused.body as { message: string }).message).toMatch(/^user still has ownership of repositories/);
      await repos.remove('p1');
      expect(await service.findRepo(hubOrgOf('p1'), HUB_REPO)).toBeNull();
      expect(await service.userExists(hubBotOf('p1'))).toBe(false);
      expect((await api('GET', `/orgs/${hubOrgOf('p1')}`, asAdmin())).status).toBe(404);
      await service.deleteOrg(hubOrgOf('p1'));
    });

    it('deletes a person with everything they own, once', async () => {
      expect(await service.deleteUser('ann')).toBe(true);
      expect(await service.deleteUser('ann')).toBe(false);
      expect(await service.userExists('ann')).toBe(false);
      expect(await service.findRepo('ann', 'shop')).toBeNull();
      expect(gitea.unhandled).toEqual([]);
    });
  });
}

import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import axios from 'axios';
import { afterEach, describe, expect, it } from 'vitest';
import { mountRouter, type Harness } from '../../platform/routes/test-harness.js';
import { nodeProcesses } from '@koala/engine-core/node-processes';
import { MachineBundle } from '../services/MachineBundle.js';
import { MachineGitService } from '../services/MachineGitService.js';
import { gitHttpRemote, type GitHttpRemote } from '../testing/git-http-remote.js';
import { machinesRouter } from './machines.js';

const REPO_ROOT = path.resolve(process.cwd(), '../..');
const REMOTE_LOGIN = 'Basic a29hbGE6c2VjcmV0';
const made: string[] = [];
const sites: Harness[] = [];
const remotes: GitHttpRemote[] = [];

afterEach(async () => {
  for (const site of sites.splice(0)) await site.close();
  for (const remote of remotes.splice(0)) await remote.close();
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

const folder = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), 'machine-git-'));
  made.push(dir);
  return dir;
};

const gitEnv = (home: string) => ({ HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' });
const as = ['-c', 'user.name=machine', '-c', 'user.email=machine@koala.local'];

async function git(cwd: string, args: string[]) {
  return nodeProcesses.run({ command: 'git', args: [...as, ...args], cwd, env: gitEnv(cwd) });
}

async function koala(options: { withGit?: boolean } = {}) {
  const remoteRoot = await folder();
  const bare = path.join(remoteRoot, 'koala-u1', 'tree-t1.git');
  const seed = await folder();
  await git(seed, ['init', '--quiet', '--initial-branch=main']);
  await writeFile(path.join(seed, 'README.md'), 'shop\n');
  await git(seed, ['add', '.']);
  await git(seed, ['commit', '--quiet', '-m', 'first']);
  await git(seed, ['clone', '--quiet', '--bare', seed, bare]);
  const remote = await gitHttpRemote(remoteRoot, REMOTE_LOGIN);
  remotes.push(remote);
  const bundleDir = await folder();
  const site = await mountRouter({
    prefix: '/api/machines',
    user: null,
    open: true,
    router: () => machinesRouter({
      bundle: new MachineBundle(REPO_ROOT, bundleDir),
      ...(options.withGit === false ? {} : {
        git: new MachineGitService({
          deviceFor: async (token) => (token === 'device-token' ? { id: 'desk', ownerId: 'u1' } : undefined),
          remote: async (ownerId, repo) => (ownerId === 'u1' && repo === 'tree-t1' ? { url: `${remote.url}/koala-u1/tree-t1.git`, authorization: REMOTE_LOGIN } : undefined),
        }),
      }),
    }),
  });
  sites.push(site);
  const signedIn = (token: string) => ['-c', 'credential.helper=', '-c', 'core.askPass=', '-c', `http.extraHeader=Authorization: Bearer ${token}`];
  return { site, bare, remoteUrl: site.url('/api/machines/git/tree-t1.git'), signedIn };
}

describe('git for a person\'s machine over HTTP, with the real git on both ends', () => {
  it('clones the person\'s repository with the machine\'s token, and a machine Koala does not know gets nothing', async () => {
    const { remoteUrl, signedIn } = await koala();
    const checkout = await folder();
    const cloned = await nodeProcesses.run({ command: 'git', args: [...signedIn('device-token'), 'clone', '--quiet', remoteUrl, path.join(checkout, 'work')], env: gitEnv(checkout) });
    expect(cloned.stderr).toBe('');
    expect(cloned.code).toBe(0);
    expect(await readFile(path.join(checkout, 'work', 'README.md'), 'utf8')).toBe('shop\n');

    for (const token of ['someone-else', '']) {
      const refused = await nodeProcesses.run({ command: 'git', args: [...signedIn(token), 'clone', '--quiet', remoteUrl, path.join(checkout, `refused-${token || 'none'}`)], env: gitEnv(checkout) });
      expect(refused.code).not.toBe(0);
      expect(refused.stderr).toMatch(/could not read Username|401|Authentication/i);
    }
    const missing = await nodeProcesses.run({ command: 'git', args: [...signedIn('device-token'), 'ls-remote', remoteUrl.replace('tree-t1', 'tree-t2')], env: gitEnv(checkout) });
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toMatch(/404|not found|no repository tree-t2 of yours/i);
  });

  it('pushes a binary file larger than git sends in one request, through its probe, to the machine\'s own work branch, byte for byte, and refuses every branch that is not its own', async () => {
    const { site, remoteUrl, signedIn, bare } = await koala();
    const checkout = await folder();
    const work = path.join(checkout, 'work');
    await nodeProcesses.run({ command: 'git', args: [...signedIn('device-token'), 'clone', '--quiet', remoteUrl, work], env: gitEnv(checkout) });
    const bytes = randomBytes(3 * 1024 * 1024);
    await writeFile(path.join(work, 'model.bin'), bytes);
    await git(work, ['add', '.']);
    await git(work, ['commit', '--quiet', '-m', 'work']);

    const own = await nodeProcesses.run({ command: 'git', args: [...as, ...signedIn('device-token'), 'push', '--quiet', 'origin', 'HEAD:refs/heads/machine/desk/run-1'], cwd: work, env: gitEnv(checkout) });
    expect(own.stderr).not.toMatch(/error|rejected|denied/i);
    expect(own.code).toBe(0);
    const shown = await nodeProcesses.run({ command: 'sh', args: ['-c', `git -C '${bare}' show machine/desk/run-1:model.bin | sha256sum`], env: gitEnv(checkout) });
    expect(shown.stdout.split(' ')[0]).toBe(createHash('sha256').update(bytes).digest('hex'));

    for (const ref of ['refs/heads/main', 'refs/heads/leaf/l1', 'refs/heads/machine/other/run-1']) {
      const refused = await nodeProcesses.run({ command: 'git', args: [...as, ...signedIn('device-token'), 'push', '--quiet', 'origin', `HEAD:${ref}`], cwd: work, env: gitEnv(checkout) });
      expect(refused.code).not.toBe(0);
      expect(refused.stderr).toContain('HTTP 403');
    }
    const crafted = Buffer.from(`${(`${'0'.repeat(40)} ${'a'.repeat(40)} refs/heads/main\0report-status\n`.length + 4).toString(16).padStart(4, '0')}${'0'.repeat(40)} ${'a'.repeat(40)} refs/heads/main\0report-status\n0000PACK`);
    const said = await axios.post(site.url('/api/machines/git/tree-t1.git/git-receive-pack'), crafted, { headers: { authorization: 'Bearer device-token', 'content-type': 'application/x-git-receive-pack-request' }, validateStatus: () => true });
    expect([said.status, said.data]).toEqual([403, 'a machine may push only its own work branches, not refs/heads/main']);
    const heads = await nodeProcesses.run({ command: 'git', args: ['-C', bare, 'for-each-ref', '--format=%(refname)'], env: gitEnv(checkout) });
    expect(heads.stdout.split('\n').filter(Boolean).sort()).toEqual(['refs/heads/machine/desk/run-1', 'refs/heads/main']);
  });

  it('serves no git at all where this Koala has none, and reads a bearer token however it is spaced and cased', async () => {
    const without = await koala({ withGit: false });
    const refused = await axios.get(without.site.url('/api/machines/git/tree-t1.git/info/refs?service=git-upload-pack'), { validateStatus: () => true });
    expect([refused.status, refused.data]).toEqual([404, 'this Koala serves no git to machines']);

    const { site } = await koala();
    const url = site.url('/api/machines/git/tree-t1.git/info/refs?service=git-upload-pack');
    for (const header of ['Bearer device-token', 'bearer   device-token ', 'BEARER device-token']) {
      const answer = await axios.get(url, { headers: { authorization: header }, validateStatus: () => true });
      expect([header, answer.status]).toEqual([header, 200]);
    }
    for (const header of [undefined, 'device-token', 'Basic device-token', 'Bearer ']) {
      const answer = await axios.get(url, { ...(header ? { headers: { authorization: header } } : {}), validateStatus: () => true });
      expect([header, answer.status]).toEqual([header, 401]);
    }
  });
});

describe('the machine agent served to a machine, from the real build', () => {
  it('serves the tarball and the checksum that is its own', async () => {
    const { site } = await koala();
    const tarball = await axios.get<ArrayBuffer>(site.url('/api/machines/agent.tgz'), { responseType: 'arraybuffer' });
    const sum = await axios.get<string>(site.url('/api/machines/agent.tgz.sha256'));
    expect(tarball.headers['content-type']).toMatch(/gzip/);
    expect(sum.data).toBe(`${createHash('sha256').update(Buffer.from(tarball.data)).digest('hex')}  machine-agent.tgz\n`);
  });
});

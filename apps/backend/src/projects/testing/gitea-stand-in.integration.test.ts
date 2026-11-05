import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { InfrastructureService } from '../../infrastructure/index.js';
import { mainHeads, syncMain } from '../../hub/services/HubRepoSync.js';
import { giteaHubRepos, HUB_REPO, hubOrgOf } from '../../hub/services/HubRepos.js';
import { GiteaService } from '../services/GiteaService.js';
import { startGiteaStandIn, type GiteaStandIn } from './gitea-stand-in.js';

const run = promisify(execFile);
const KEY = 'gitea-stand-in-test-key' as never;

let gitea: GiteaStandIn;
let service: GiteaService;
let dataDir: string;
let saved: string | undefined;
let hooks: http.Server;
let hookUrl: string;
const heard: { body: Buffer; signature: string | undefined }[] = [];

beforeAll(async () => {
  gitea = await startGiteaStandIn();
  saved = process.env.GITEA_URL;
  process.env.GITEA_URL = gitea.url;
  dataDir = await mkdtemp(path.join(tmpdir(), 'gitea-stand-in-data-'));
  await writeFile(path.join(dataDir, '.gitea-admin-password'), gitea.adminPassword);
  const infra = mock<Pick<InfrastructureService, 'runKubectl' | 'getK3dServerIp'>>();
  infra.runKubectl.mockRejectedValue(new Error('no cluster here'));
  service = new GiteaService(infra, KEY, '/nowhere', { dataDir });
  hooks = http.createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (part: Buffer) => parts.push(part));
    req.on('end', () => { heard.push({ body: Buffer.concat(parts), signature: req.headers['x-gitea-signature'] as string | undefined }); res.writeHead(202).end(); });
  });
  await new Promise<void>((done) => hooks.listen(0, '127.0.0.1', done));
  hookUrl = `http://127.0.0.1:${(hooks.address() as AddressInfo).port}/hook`;
});

afterAll(async () => {
  if (saved === undefined) delete process.env.GITEA_URL; else process.env.GITEA_URL = saved;
  await new Promise<void>((done) => hooks.close(() => done()));
  await gitea.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe('the Gitea stand-in, driven by GiteaService as the backend drives Gitea', () => {
  it('makes a person\'s account and a repository started with a README and a .gitignore, read back file by file', async () => {
    await service.createUserAccount('ann', 'ann@koala.local');
    expect(await service.userExists('ann')).toBe(true);
    expect(await service.userExists('nobody')).toBe(false);
    await service.createRepoForUser('ann', 'shop', { private: true });
    expect(await service.findRepo('ann', 'shop')).toEqual({ owner: 'ann', name: 'shop' });
    expect(await service.findRepo('ann', 'other')).toBeNull();
    expect((await service.listPaths('ann', 'shop', 'main')).sort()).toEqual(['.gitignore', 'README.md']);
    expect(await service.getRawFile('ann', 'shop', 'README.md', 'main')).toBe('# shop\n');
    expect(await service.repoServesFiles('ann', 'shop')).toBe(true);
  });

  it('writes a file on main, refuses a stale write, and tells a webhook signed with its secret', async () => {
    await service.replaceWebhook('ann', 'shop', hookUrl, 'hook-secret');
    await service.replaceWebhook('ann', 'shop', hookUrl, 'hook-secret');
    const first = await service.putFile('ann', 'shop', 'notes.txt', 'one\n', 'Add notes', 'main');
    expect(first.changed).toBe(true);
    expect(await service.putFile('ann', 'shop', 'notes.txt', 'one\n', 'Again', 'main')).toEqual({ changed: false });
    expect(await service.getRawFile('ann', 'shop', 'notes.txt', 'main')).toBe('one\n');
    expect(heard).toHaveLength(1);
    expect(service.verifyWebhookSignature(heard[0]!.body, heard[0]!.signature, 'hook-secret')).toBe(true);
    expect(JSON.parse(heard[0]!.body.toString('utf8'))).toMatchObject({ ref: 'refs/heads/main', after: first.commit, commits: [{ added: ['notes.txt'] }] });
  });

  it('refuses anyone who does not sign in, over the API and over git', async () => {
    expect((await fetch(`${gitea.url}/api/v1/repos/ann/shop`)).status).toBe(401);
    const listed = await run('git', ['ls-remote', await service.repoGitUrl('ann', 'shop')], { env: { PATH: process.env.PATH, GIT_TERMINAL_PROMPT: '0' } }).catch((err: Error) => err);
    expect(listed).toBeInstanceOf(Error);
  });

  it('keeps a shared project\'s repository in an organisation its bot pushes to, synced with the owner\'s main, and removes it all', async () => {
    const repos = giteaHubRepos(service, { url: async () => hookUrl, secret: () => 'hub-secret' });
    const access = await repos.create('p1');
    expect(await service.findRepo(hubOrgOf('p1'), HUB_REPO)).not.toBeNull();
    const admin = await service.getAdminCredentials();
    const owner = { url: await service.repoGitUrl('ann', 'shop'), auth: { username: admin.username, token: admin.password } };
    const hub = { url: access.url, auth: { username: access.username, token: access.token } };
    const before = heard.length;
    expect((await syncMain(owner, hub, () => 'kept')).outcome).toBe('to-hub');
    const heads = await mainHeads(owner, hub);
    expect(heads.owner).toBeTruthy();
    expect(heads.hub).toBe(heads.owner);
    expect(heard.length).toBe(before + 1);
    expect(service.verifyWebhookSignature(heard.at(-1)!.body, heard.at(-1)!.signature, 'hub-secret')).toBe(true);
    expect((await repos.files('p1')).sort()).toEqual(['.gitignore', 'README.md', 'notes.txt']);
    expect(await repos.read('p1', 'notes.txt')).toBe('one\n');
    await repos.remove('p1');
    expect(await service.findRepo(hubOrgOf('p1'), HUB_REPO)).toBeNull();
    expect(gitea.unhandled).toEqual([]);
  });
});

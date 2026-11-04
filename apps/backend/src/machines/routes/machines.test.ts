import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { GitAsk, MachineGitService } from '../services/MachineGitService.js';
import type { MachineAccounts } from '../services/MachineAccounts.js';
import { routesInProcess } from '../../platform/testing/routes.js';
import { machinesRouter, type AgentBundle } from './machines.js';

type Git = Pick<MachineGitService, 'serve'>;

const SHA = 'ab'.repeat(32);

let machines: ReturnType<typeof mock<Pick<MachineAccounts, 'join'>>>;
let git: ReturnType<typeof mock<Git>>;
let bundle: ReturnType<typeof mock<AgentBundle>>;
let dir: string;

const asked = (): GitAsk => git.serve.mock.calls[0]![0];

interface Call { method?: 'GET' | 'POST'; path: string; body?: unknown; headers?: Record<string, string> }

const call = async (over: Call, withGit = true, withAccounts = true) => {
  const routes = await routesInProcess({ prefix: '/api/machines', router: () => machinesRouter({ ...(withAccounts ? { accounts: machines } : {}), bundle, ...(withGit ? { git } : {}) }), user: null, open: true });
  return routes.request(over.method ?? 'GET', `/api/machines${over.path}`, { body: over.body, headers: over.headers });
};

beforeEach(async () => {
  machines = mock<Pick<MachineAccounts, 'join'>>();
  git = mock<Git>();
  bundle = mock<AgentBundle>();
  bundle.sha256.mockResolvedValue(SHA);
  dir = await mkdtemp(path.join(tmpdir(), 'machines-route-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('/api/machines/join', () => {
  it('joins a machine with the code and what it says about itself, and hands back its settings with the bundle\'s checksum', async () => {
    machines.join.mockResolvedValue({ ok: true, value: { deviceId: 'dev-1', env: { KOALA_DEVICE_ID: 'dev-1' } } });
    const answer = await call({ method: 'POST', path: '/join', body: { code: 'abc', hostname: 'laptop', rootDir: '/home/me', os: 'Linux', replaces: 'old-token', ignored: 'x' } });
    expect(answer.status).toBe(200);
    expect(answer.data).toEqual({ deviceId: 'dev-1', env: { KOALA_DEVICE_ID: 'dev-1', KOALA_AGENT_SHA256: SHA } });
    expect(machines.join).toHaveBeenCalledWith('abc', { hostname: 'laptop', rootDir: '/home/me', os: 'Linux', replaces: 'old-token' });
  });

  it('answers a refusal in plain text with its status', async () => {
    machines.join.mockResolvedValue({ ok: false, status: 401, error: 'that command has expired or was already used: make a new one on My Machines' });
    const answer = await call({ method: 'POST', path: '/join', body: { code: 'abc' } });
    expect(answer.status).toBe(401);
    expect(answer.text).toBe('that command has expired or was already used: make a new one on My Machines');
    expect(answer.headers['content-type']).toContain('text/plain');
  });

  it('sends a machine to root where this Koala holds no accounts', async () => {
    const answer = await call({ method: 'POST', path: '/join', body: { code: 'abc' } }, true, false);
    expect([answer.status, answer.text]).toEqual([404, 'machines join at root, which holds accounts: run the command from My Machines']);
    expect(machines.join).not.toHaveBeenCalled();
  });

  it('treats a request with no body as one with no code', async () => {
    machines.join.mockResolvedValue({ ok: false, status: 400, error: 'send the code from My Machines as "code"' });
    await call({ method: 'POST', path: '/join' });
    expect(machines.join).toHaveBeenCalledWith(undefined, { hostname: undefined, rootDir: undefined, os: undefined, replaces: undefined });
  });
});

describe('/api/machines/agent.tgz', () => {
  it('serves the bundle it built', async () => {
    const file = path.join(dir, 'machine-agent.tgz');
    await writeFile(file, 'tarball bytes');
    bundle.path.mockResolvedValue(file);
    const answer = await call({ path: '/agent.tgz' });
    expect(answer.status).toBe(200);
    expect(answer.headers['content-type']).toBe('application/gzip');
    expect(answer.text).toBe('tarball bytes');
  });

  it('serves its checksum in the form sha256sum reads', async () => {
    const answer = await call({ path: '/agent.tgz.sha256' });
    expect(answer.status).toBe(200);
    expect(answer.text).toBe(`${SHA}  machine-agent.tgz\n`);
    expect(answer.headers['content-type']).toContain('text/plain');
  });
});

describe('/api/machines/git', () => {
  it('hands a request for a repository to the git service with the token, the repository, the route and the headers git sent', async () => {
    git.serve.mockResolvedValue({ status: 200, headers: { 'content-type': 'application/x-git-upload-pack-advertisement' }, body: Readable.from(['001e# service=git-upload-pack\n']) });
    const answer = await call({
      path: '/git/shop.git/info/refs?service=git-upload-pack',
      headers: { authorization: 'Bearer the-device-token', 'git-protocol': 'version=2' },
    });
    expect(answer.status).toBe(200);
    expect(answer.headers['content-type']).toBe('application/x-git-upload-pack-advertisement');
    expect(answer.text).toBe('001e# service=git-upload-pack\n');
    expect(asked()).toMatchObject({ token: 'the-device-token', repo: 'shop', route: 'info/refs', service: 'git-upload-pack', gitProtocol: 'version=2', body: undefined });
  });

  it('streams what a push sends to the service as the body, with its encoding', async () => {
    git.serve.mockResolvedValue({ status: 200, headers: {}, body: Readable.from(['ok']) });
    const pushed = await call({
      method: 'POST',
      path: '/git/my%20shop.git/git-receive-pack',
      headers: { authorization: 'bearer   spaced-token ', 'content-type': 'application/x-git-receive-pack-request', 'content-encoding': 'identity' },
      body: { pack: 'data' },
    });
    expect(pushed.status).toBe(200);
    expect(asked()).toMatchObject({ token: 'spaced-token', repo: 'my shop', route: 'git-receive-pack', service: undefined, gitProtocol: undefined, contentEncoding: 'identity' });
    expect(asked().body).toBeDefined();
  });

  it('asks a machine that sent no token to sign in, and passes on any other refusal in words', async () => {
    git.serve.mockResolvedValueOnce({ status: 401, text: 'a device token is needed' });
    const unsigned = await call({ path: '/git/shop.git/info/refs' });
    expect(unsigned.status).toBe(401);
    expect(unsigned.text).toBe('a device token is needed');
    expect(unsigned.headers['www-authenticate']).toBe('Bearer realm="koala"');
    expect(asked().token).toBeUndefined();

    git.serve.mockResolvedValueOnce({ status: 404, text: 'no such repository' });
    const missing = await call({ path: '/git/other.git/info/refs', headers: { authorization: 'Bearer t' } });
    expect(missing.status).toBe(404);
    expect(missing.headers['www-authenticate']).toBeUndefined();
  });

  it('serves no git where this Koala has none', async () => {
    const answer = await call({ path: '/git/shop.git/info/refs' }, false);
    expect(answer.status).toBe(404);
    expect(answer.text).toBe('this Koala serves no git to machines');
  });

  it('answers only the three routes git uses', async () => {
    const answer = await call({ path: '/git/shop.git/objects/info/packs' });
    expect(answer.status).toBe(404);
    expect(git.serve).not.toHaveBeenCalled();
  });
});

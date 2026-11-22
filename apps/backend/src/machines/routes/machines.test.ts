import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { GitAsk, MachineGitService } from '../services/MachineGitService.js';
import type { MachineAccounts } from '../services/MachineAccounts.js';
import type { InstallFollower, KoalaInstalls } from '../services/KoalaInstalls.js';
import type { MachineMetricsRelay } from '../services/MachineMetricsRelay.js';
import { routesInProcess } from '../../platform/testing/routes.js';
import { machinesRouter, type AgentBundle } from './machines.js';

type Git = Pick<MachineGitService, 'serve'>;

const SHA = 'ab'.repeat(32);

let machines: ReturnType<typeof mock<Pick<MachineAccounts, 'join' | 'reportJoinProgress'>>>;
let installs: ReturnType<typeof mock<Pick<KoalaInstalls, 'report' | 'follow'>>>;
let git: ReturnType<typeof mock<Git>>;
let bundle: ReturnType<typeof mock<AgentBundle>>;
let dir: string;

const asked = (): GitAsk => git.serve.mock.calls[0]![0];

interface Call { method?: 'GET' | 'POST'; path: string; body?: unknown; headers?: Record<string, string> }

const call = async (over: Call, withGit = true, withAccounts = true, followBeatMs?: number) => {
  const routes = await routesInProcess({ prefix: '/api/machines', router: () => machinesRouter({ ...(withAccounts ? { accounts: machines, installs } : {}), bundle, ...(withGit ? { git } : {}), followBeatMs }), user: null, open: true });
  return routes.request(over.method ?? 'GET', `/api/machines${over.path}`, { body: over.body, headers: over.headers });
};

beforeEach(async () => {
  machines = mock<Pick<MachineAccounts, 'join' | 'reportJoinProgress'>>();
  installs = mock<Pick<KoalaInstalls, 'report' | 'follow'>>();
  git = mock<Git>();
  bundle = mock<AgentBundle>();
  bundle.sha256.mockResolvedValue(SHA);
  dir = await mkdtemp(path.join(tmpdir(), 'machines-route-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('/api/machines/join-progress', () => {
  const stage = { stage: 'k3s', title: 'Installing k3s', state: 'started' };

  it('records a stage with the join code as its bearer credential, answering with nothing', async () => {
    machines.reportJoinProgress.mockResolvedValue({ ok: true, value: { recorded: true } });
    const answer = await call({ method: 'POST', path: '/join-progress', body: stage, headers: { authorization: 'Bearer the-code' } });
    expect(answer.status).toBe(204);
    expect(machines.reportJoinProgress).toHaveBeenCalledWith('the-code', stage);
  });

  it('hands on no code when none is sent, and answers a refusal in plain text with its status', async () => {
    machines.reportJoinProgress.mockResolvedValue({ ok: false, status: 400, error: '"state" is one of started, done, already-done, failed' });
    const answer = await call({ method: 'POST', path: '/join-progress', body: { ...stage, state: 'skipped' } });
    expect(machines.reportJoinProgress).toHaveBeenCalledWith(undefined, { ...stage, state: 'skipped' });
    expect(answer.status).toBe(400);
    expect(answer.text).toBe('"state" is one of started, done, already-done, failed');
    expect(answer.headers['content-type']).toContain('text/plain');
  });

  it('sends a machine to root where this Koala holds no accounts', async () => {
    const answer = await call({ method: 'POST', path: '/join-progress', body: stage, headers: { authorization: 'Bearer the-code' } }, true, false);
    expect(answer.status).toBe(404);
  });
});

describe('/api/machines/koala-installs/:installId/progress', () => {
  const stage = { stage: 'koala', title: 'Putting Koala on this machine', state: 'started' };

  it('hands the install a stage with the machine\'s own token as its bearer credential, answering with nothing', async () => {
    installs.report.mockResolvedValue({ ok: true, value: { recorded: true } });
    const answer = await call({ method: 'POST', path: '/koala-installs/install%201/progress', body: stage, headers: { authorization: 'Bearer desk-token' } });
    expect(answer.status).toBe(204);
    expect(installs.report).toHaveBeenCalledWith('install 1', 'desk-token', stage);
  });

  it('answers a refusal in plain text with its status', async () => {
    installs.report.mockResolvedValue({ ok: false, status: 409, error: 'that install has ended ready' });
    const answer = await call({ method: 'POST', path: '/koala-installs/install-1/progress', body: stage, headers: { authorization: 'Bearer desk-token' } });
    expect([answer.status, answer.text]).toEqual([409, 'that install has ended ready']);
    expect(answer.headers['content-type']).toContain('text/plain');
  });

  it('sends a machine to root where this Koala puts Koala on no machines', async () => {
    const answer = await call({ method: 'POST', path: '/koala-installs/install-1/progress', body: stage, headers: { authorization: 'Bearer desk-token' } }, true, false);
    expect([answer.status, answer.text]).toEqual([404, 'machines report putting Koala on themselves to root, which asked them']);
    expect(installs.report).not.toHaveBeenCalled();
  });
});

describe('GET /api/machines/koala-installs/following', () => {
  const at = '2026-11-18T10:00:00.000Z';
  const chart = { kind: 'followed', followed: { install: { id: 'install-1', machineId: 'desk', state: 'installing', stage: 'chart', title: 'Installing Koala\'s chart', line: 'waiting for deployment/koala', at } } } as const;
  const ready = { kind: 'followed', followed: { install: { id: 'install-1', machineId: 'desk', state: 'ready', at }, url: 'https://bobby.koala.app' } } as const;
  const stopped = { stop: () => undefined };

  it('streams each change of the install as an event, with the machine\'s own token, ending when the install ends', async () => {
    installs.follow.mockImplementation(async (_token, listener) => {
      listener.told({ kind: 'waiting' });
      listener.told(chart);
      listener.told(ready);
      return { ok: true, value: stopped };
    });
    const answer = await call({ path: '/koala-installs/following', headers: { authorization: 'Bearer desk-token' } });
    expect(installs.follow.mock.calls[0]![0]).toBe('desk-token');
    expect(answer.status).toBe(200);
    expect(answer.headers['content-type']).toContain('text/event-stream');
    expect(answer.text).toBe(`data: ${JSON.stringify(chart.followed)}\n\ndata: ${JSON.stringify(ready.followed)}\n\n`);
  });

  it('ends with why when root stopped putting Koala on the machine before any install ended', async () => {
    installs.follow.mockImplementation(async (_token, listener) => {
      listener.told({ kind: 'stopped', why: 'your Koala is on laptop' });
      return { ok: true, value: stopped };
    });
    const answer = await call({ path: '/koala-installs/following', headers: { authorization: 'Bearer desk-token' } });
    expect(answer.text).toBe('event: stopped\ndata: {"why":"your Koala is on laptop"}\n\n');
  });

  it('beats while the install is quiet, so the machine knows root is still there, until the install ends', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      let following: InstallFollower | undefined;
      installs.follow.mockImplementation(async (_token, listener) => {
        listener.told(chart);
        following = listener;
        return { ok: true, value: stopped };
      });
      const answering = call({ path: '/koala-installs/following', headers: { authorization: 'Bearer desk-token' } }, true, true, 1000);
      await vi.waitFor(() => { if (!following) throw new Error('the route has not followed the install yet'); });
      vi.advanceTimersByTime(2000);
      following!.told(ready);
      const answer = await answering;
      expect(answer.text).toBe(`data: ${JSON.stringify(chart.followed)}\n\n: beat\n\n: beat\n\ndata: ${JSON.stringify(ready.followed)}\n\n`);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cuts the machine off when root can no longer read the install it follows, and stops following', async () => {
    let stops = 0;
    installs.follow.mockImplementation(async (_token, listener) => {
      listener.told(chart);
      setImmediate(() => { listener.broke(new Error('the database is not connected')); });
      return { ok: true, value: { stop: () => { stops += 1; } } };
    });
    const cut = await call({ path: '/koala-installs/following', headers: { authorization: 'Bearer desk-token' } }).then((answer) => answer.text, (err: Error) => err.message);
    expect(cut).not.toContain(JSON.stringify(ready.followed));
    expect(stops).toBe(1);
  });

  it('answers with nothing when the join asked for no Koala', async () => {
    installs.follow.mockImplementation(async (_token, listener) => {
      listener.told({ kind: 'none' });
      return { ok: true, value: stopped };
    });
    const answer = await call({ path: '/koala-installs/following', headers: { authorization: 'Bearer desk-token' } });
    expect([answer.status, answer.text]).toEqual([204, '']);
  });

  it('answers a refusal in plain text with its status, and sends a machine to root where this Koala puts Koala on no machines', async () => {
    installs.follow.mockResolvedValue({ ok: false, status: 401, error: 'send this machine\'s own token as the bearer credential' });
    const refused = await call({ path: '/koala-installs/following' });
    expect([refused.status, refused.text]).toEqual([401, 'send this machine\'s own token as the bearer credential']);
    expect(installs.follow.mock.calls[0]![0]).toBeUndefined();
    const elsewhere = await call({ path: '/koala-installs/following', headers: { authorization: 'Bearer desk-token' } }, true, false);
    expect([elsewhere.status, elsewhere.text]).toEqual([404, 'machines follow putting Koala on themselves at root, which asked them']);
  });
});

describe('/api/machines/join', () => {
  it('joins a machine with the code and what it says about itself, and hands back its settings with the bundle\'s checksum', async () => {
    machines.join.mockResolvedValue({ ok: true, value: { deviceId: 'dev-1', env: { KOALA_DEVICE_ID: 'dev-1' } } });
    const answer = await call({ method: 'POST', path: '/join', body: { code: 'abc', hostname: 'laptop', rootDir: '/home/me', os: 'Linux', replaces: 'client-token', replacesKeyless: 'old-token', ignored: 'x' } });
    expect(answer.status).toBe(200);
    expect(answer.data).toEqual({ deviceId: 'dev-1', env: { KOALA_DEVICE_ID: 'dev-1', KOALA_AGENT_SHA256: SHA } });
    expect(machines.join).toHaveBeenCalledWith('abc', { hostname: 'laptop', rootDir: '/home/me', os: 'Linux', replaces: 'client-token', replacesKeyless: 'old-token' });
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

describe('POST /api/machines/metrics', () => {
  const metricsCall = async (raw: Buffer, headers: Record<string, string>, relay?: { write: ReturnType<typeof mock<Pick<MachineMetricsRelay, 'write'>>>['write'] }) => {
    const routes = await routesInProcess({ prefix: '/api/machines', router: () => machinesRouter({ bundle, ...(relay ? { metrics: relay } : {}) }), user: null, open: true });
    return routes.request('POST', '/api/machines/metrics', { raw, headers });
  };

  it('hands the relay the token and the body as sent, snappy and all, and answers as it does', async () => {
    const relay = mock<Pick<MachineMetricsRelay, 'write'>>();
    relay.write.mockResolvedValue({ status: 204 });
    const answer = await metricsCall(Buffer.from([1, 2, 3]), { authorization: 'Bearer tok', 'content-encoding': 'snappy', 'content-type': 'application/x-protobuf' }, relay);
    expect(answer.status).toBe(204);
    expect(relay.write).toHaveBeenCalledWith('tok', Buffer.from([1, 2, 3]));
  });

  it('passes on what the relay refused, and is not there where no metrics are taken', async () => {
    const relay = mock<Pick<MachineMetricsRelay, 'write'>>();
    relay.write.mockResolvedValue({ status: 401, text: 'no machine\'s cluster sends with that token' });
    expect(await metricsCall(Buffer.alloc(0), {}, relay)).toMatchObject({ status: 401 });
    expect((await metricsCall(Buffer.alloc(0), {})).status).toBe(404);
  });
});

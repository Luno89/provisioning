import { describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { MachineGitService, type GitAsk } from './MachineGitService.js';

const pkt = (line: string): string => `${(line.length + 4).toString(16).padStart(4, '0')}${line}`;
const ZERO = '0'.repeat(40);
const A = 'a'.repeat(40);
const pushTo = (ref: string): Buffer => Buffer.from(`${pkt(`${ZERO} ${A} ${ref}\0report-status\n`)}0000PACK`);

const setUp = () => {
  const sent: Buffer[] = [];
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.body instanceof ReadableStream) sent.push(Buffer.concat(await Readable.fromWeb(init.body as never).toArray()));
    return new Response('answered', { status: 200, headers: { 'content-type': 'application/x-git-receive-pack-result', 'x-gitea': 'hidden' } });
  });
  const service = new MachineGitService({
    deviceFor: async (token) => (token === 'device-token' ? { id: 'desk', ownerId: 'u1' } : undefined),
    remote: async (ownerId, repo) => (ownerId === 'u1' && repo === 'tree-t1' ? { url: 'http://gitea/koala-u1/tree-t1.git', authorization: 'Basic secret' } : undefined),
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  return { service, fetchImpl, sent };
};

const ask = (over: Partial<GitAsk>): GitAsk => ({
  token: 'device-token', repo: 'tree-t1', route: 'info/refs', service: 'git-upload-pack',
  contentType: undefined, contentEncoding: undefined, gitProtocol: undefined, body: undefined, ...over,
});

const text = async (answer: Awaited<ReturnType<MachineGitService['serve']>>): Promise<string> =>
  'text' in answer ? answer.text : (await answer.body.toArray()).map(String).join('');

describe('git for a person\'s machine, through Koala', () => {
  it('fetches from the person\'s own repository, signed in as them, with only git\'s headers passed back', async () => {
    const { service, fetchImpl } = setUp();
    const answer = await service.serve(ask({ gitProtocol: 'version=2' }));
    expect(answer.status).toBe(200);
    expect('headers' in answer && answer.headers).toEqual({ 'content-type': 'application/x-git-receive-pack-result' });
    expect(await text(answer)).toBe('answered');
    expect(fetchImpl).toHaveBeenCalledWith('http://gitea/koala-u1/tree-t1.git/info/refs?service=git-upload-pack', expect.objectContaining({
      method: 'GET', headers: { Authorization: 'Basic secret', 'Git-Protocol': 'version=2' },
    }));
  });

  it('pushes only to the machine\'s own work branches, reading a gzipped push too', async () => {
    const { service, fetchImpl, sent } = setUp();
    const own = await service.serve(ask({ route: 'git-receive-pack', service: undefined, contentEncoding: 'gzip', body: Readable.from([gzipSync(pushTo('refs/heads/machine/desk/run-1'))]) }));
    expect(own.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledWith('http://gitea/koala-u1/tree-t1.git/git-receive-pack', expect.objectContaining({ method: 'POST' }));
    expect(sent[0]).toEqual(pushTo('refs/heads/machine/desk/run-1'));

    for (const ref of ['refs/heads/main', 'refs/heads/leaf/l1', 'refs/heads/machine/other/run-1']) {
      const refused = await service.serve(ask({ route: 'git-receive-pack', service: undefined, body: Readable.from([pushTo(ref)]) }));
      expect(refused).toEqual({ status: 403, text: `a machine may push only its own work branches, not ${ref}` });
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refuses a machine it does not know, a repository that is not the person\'s, and anything but fetching and pushing', async () => {
    const { service, fetchImpl } = setUp();
    expect(await service.serve(ask({ token: undefined }))).toEqual({ status: 401, text: 'this machine did not say who it is' });
    expect(await service.serve(ask({ token: 'stolen' }))).toEqual({ status: 401, text: 'this machine is not one Koala knows' });
    expect(await service.serve(ask({ repo: 'someone-else' }))).toEqual({ status: 404, text: 'there is no repository someone-else of yours' });
    expect(await service.serve(ask({ service: 'git-upload-archive' }))).toEqual({ status: 400, text: 'only fetching and pushing are served here' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('streams a push through, reading only its commands, however its bytes arrive and however large its pack', async () => {
    const { service, sent } = setUp();
    const pack = Buffer.alloc(8 * 1024 * 1024, 7);
    const whole = Buffer.concat([pushTo('refs/heads/machine/desk/run-2'), pack]);
    const trickled = [whole.subarray(0, 3), whole.subarray(3, 20), whole.subarray(20, 70), whole.subarray(70)];
    const answer = await service.serve(ask({ route: 'git-receive-pack', service: undefined, body: Readable.from(trickled) }));
    expect(answer.status).toBe(200);
    expect(sent[0]!.equals(whole)).toBe(true);
  });

  it('refuses a push whose commands run on past anything git sends, without reading the rest', async () => {
    const { service, fetchImpl } = setUp();
    const endless = (async function* () { for (;;) yield Buffer.from(pkt(`${ZERO} ${A} refs/heads/machine/desk/${'x'.repeat(200)}\n`)); })();
    const answer = await service.serve(ask({ route: 'git-receive-pack', service: undefined, body: Readable.from(endless) }));
    expect(answer).toEqual({ status: 400, text: 'the push\'s commands run longer than any push git sends' });
    expect(fetchImpl).not.toHaveBeenCalled();
  }, 30_000);
});

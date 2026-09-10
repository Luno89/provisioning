import { describe, it, expect, vi, beforeEach } from 'vitest';

const runDockerMock = vi.fn();
vi.mock('./docker-cli.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./docker-cli.js')>()),
  runDocker: (...args: unknown[]) => runDockerMock(...args),
}));

const {
  createContainer, destroyContainer, execInContainer, readFileInContainer, writeFileInContainer,
  __resetForTests,
} = await import('./docker-driver.js');

const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0, timedOut: false });
const fail = (stderr = 'boom') => ({ stdout: '', stderr, exitCode: 1, timedOut: false });

function argsOf(call: unknown[]): string[] {
  return call[0] as string[];
}

beforeEach(() => {
  runDockerMock.mockReset();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
  __resetForTests();
});

/** Wires up the exact sequence createContainer() drives, for a proxy that is not already running. */
function mockHappyPathCreate(proxyIp = '172.20.0.2', workspaceIp = '172.20.0.3') {
  runDockerMock.mockImplementation(async (args: string[]) => {
    if (args[0] === 'inspect' && args[2] === '{{.State.Running}}') return fail(); // proxy not running yet
    if (args[0] === 'run' && args.includes('koala-egress-proxy')) return ok();
    if (args[0] === 'network' && args[1] === 'create') return ok();
    if (args[0] === 'network' && args[1] === 'connect') return ok();
    if (args[0] === 'inspect' && args[1] === 'koala-egress-proxy') return ok(proxyIp);
    if (args[0] === 'run' && args.includes('koala-leaf-leaf-1')) return ok();
    if (args[0] === 'inspect' && args[1] === 'koala-leaf-leaf-1') return ok(workspaceIp);
    throw new Error(`unexpected docker call: ${args.join(' ')}`);
  });
}

describe('createContainer', () => {
  it('starts the workspace container with the exact isolation flags the plan committed to', async () => {
    mockHappyPathCreate();

    await createContainer({
      leafId: 'leaf-1', image: 'ubi9/nodejs-22', rootDir: '/home/me/project', cpu: '2', memory: '2g',
      egress: [{ host: 'registry.npmjs.org' }],
    });

    const runCall = runDockerMock.mock.calls.find((c) => argsOf(c)[0] === 'run' && argsOf(c).includes('koala-leaf-leaf-1'));
    expect(runCall).toBeDefined();
    const args = argsOf(runCall!);

    expect(args).toEqual(expect.arrayContaining([
      '--user', '1000:1000',
      '--read-only',
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--cpus', '2',
      '--memory', '2g',
      '-v', '/home/me/project:/work',
      '-w', '/work',
      '--network', 'koala-leaf-net-leaf-1',
      'ubi9/nodejs-22',
      'sleep', 'infinity',
    ]));
    expect(args).toContain('HTTP_PROXY=http://172.20.0.2:38080');
  });

  it('creates a per-leaf internal network and connects the shared proxy to it', async () => {
    mockHappyPathCreate();
    await createContainer({ leafId: 'leaf-1', image: 'x', rootDir: '/x' });

    expect(runDockerMock.mock.calls.some((c) => {
      const a = argsOf(c);
      return a[0] === 'network' && a[1] === 'create' && a.includes('--internal') && a.includes('koala-leaf-net-leaf-1');
    })).toBe(true);
    expect(runDockerMock.mock.calls.some((c) => {
      const a = argsOf(c);
      return a[0] === 'network' && a[1] === 'connect' && a[2] === 'koala-leaf-net-leaf-1' && a[3] === 'koala-egress-proxy';
    })).toBe(true);
  });

  it('registers the workspace container\'s resolved IP with the proxy allowlist', async () => {
    mockHappyPathCreate(undefined, '172.20.0.9');
    await createContainer({ leafId: 'leaf-1', image: 'x', rootDir: '/x', egress: [{ host: 'registry.npmjs.org' }] });

    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:38081/allowlist',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ containerIp: '172.20.0.9', rules: [{ host: 'registry.npmjs.org' }] }),
      }),
    );
  });

  it('does not start a second proxy container when one is already running', async () => {
    runDockerMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'inspect' && args[2] === '{{.State.Running}}') return ok('true');
      if (args[0] === 'network' && args[1] === 'create') return ok();
      if (args[0] === 'network' && args[1] === 'connect') return ok();
      if (args[0] === 'inspect' && args[1] === 'koala-egress-proxy') return ok('172.20.0.2');
      if (args[0] === 'run' && args.includes('koala-leaf-leaf-1')) return ok();
      if (args[0] === 'inspect' && args[1] === 'koala-leaf-leaf-1') return ok('172.20.0.3');
      throw new Error(`unexpected docker call: ${args.join(' ')}`);
    });

    await createContainer({ leafId: 'leaf-1', image: 'x', rootDir: '/x' });

    expect(runDockerMock.mock.calls.some((c) => argsOf(c)[0] === 'run' && argsOf(c).includes('koala-egress-proxy'))).toBe(false);
  });

  it('rejects with the real docker stderr when the workspace container fails to start', async () => {
    runDockerMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'inspect' && args[2] === '{{.State.Running}}') return ok('true');
      if (args[0] === 'network' && args[1] === 'create') return ok();
      if (args[0] === 'network' && args[1] === 'connect') return ok();
      if (args[0] === 'inspect' && args[1] === 'koala-egress-proxy') return ok('172.20.0.2');
      if (args[0] === 'run') return fail('Error: No such image: bogus-image');
      throw new Error(`unexpected docker call: ${args.join(' ')}`);
    });

    await expect(createContainer({ leafId: 'leaf-1', image: 'bogus-image', rootDir: '/x' }))
      .rejects.toThrow(/No such image/);
  });
});

describe('destroyContainer', () => {
  it('stops the container, clears the allowlist, disconnects and removes the network', async () => {
    mockHappyPathCreate(undefined, '172.20.0.9');
    await createContainer({ leafId: 'leaf-1', image: 'x', rootDir: '/x' });
    runDockerMock.mockClear();
    vi.mocked(fetch).mockClear();

    runDockerMock.mockResolvedValue(ok());
    await destroyContainer('leaf-1');

    const calls = runDockerMock.mock.calls.map((c) => argsOf(c));
    expect(calls[0]).toEqual(['stop', 'koala-leaf-leaf-1']);
    expect(calls.some((a) => a[0] === 'network' && a[1] === 'disconnect' && a.includes('koala-leaf-net-leaf-1'))).toBe(true);
    expect(calls.some((a) => a[0] === 'network' && a[1] === 'rm' && a[2] === 'koala-leaf-net-leaf-1')).toBe(true);
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:38081/allowlist/172.20.0.9', { method: 'DELETE' });
  });

  it('never throws, even when every docker call fails', async () => {
    runDockerMock.mockResolvedValue(fail());
    await expect(destroyContainer('leaf-never-created')).resolves.toBeUndefined();
  });
});

describe('exec/read/write in a container', () => {
  it('exec runs the command via sh -c inside the named container', async () => {
    runDockerMock.mockResolvedValue(ok('hello\n'));
    const result = await execInContainer('leaf-1', 'echo hello', 5000);
    expect(runDockerMock).toHaveBeenCalledWith(['exec', 'koala-leaf-leaf-1', 'sh', '-c', 'echo hello'], { timeoutMs: 5000 });
    expect(result.stdout).toBe('hello\n');
  });

  it('writeFile base64-encodes content and pipes it in via stdin', async () => {
    runDockerMock.mockResolvedValue(ok());
    await writeFileInContainer('leaf-1', 'a.txt', 'hello');
    const call = runDockerMock.mock.calls[0]!;
    expect(argsOf(call)).toEqual([
      'exec', '-i', 'koala-leaf-leaf-1', 'sh', '-c', 'mkdir -p "$(dirname "$1")" && base64 -d > "$1"', 'sh', 'a.txt',
    ]);
    expect((call[1] as { stdin: string }).stdin).toBe(Buffer.from('hello').toString('base64'));
  });

  it('readFile decodes the base64 the container printed', async () => {
    runDockerMock.mockResolvedValue(ok(Buffer.from('file contents').toString('base64')));
    expect(await readFileInContainer('leaf-1', 'a.txt')).toBe('file contents');
  });

  it('readFile throws with the real stderr when the file does not exist', async () => {
    runDockerMock.mockResolvedValue(fail('cat: a.txt: No such file or directory'));
    await expect(readFileInContainer('leaf-1', 'a.txt')).rejects.toThrow(/No such file/);
  });
});

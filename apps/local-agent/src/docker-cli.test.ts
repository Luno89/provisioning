import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

const spawnMock = vi.fn();
vi.mock('child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));

const { runDocker, dockerAvailable } = await import('./docker-cli.js');

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { end: vi.fn() };
  kill = vi.fn();
}

function finish(child: FakeChild, { stdout = '', stderr = '', code = 0 }: { stdout?: string; stderr?: string; code?: number } = {}) {
  if (stdout) child.stdout.emit('data', Buffer.from(stdout));
  if (stderr) child.stderr.emit('data', Buffer.from(stderr));
  child.emit('close', code);
}

beforeEach(() => { spawnMock.mockReset(); });

describe('runDocker', () => {
  it('spawns the docker binary directly, with no shell, args as an array', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);

    const promise = runDocker(['ps', '-a']);
    expect(spawnMock).toHaveBeenCalledWith('docker', ['ps', '-a']);
    finish(child, { stdout: 'CONTAINER ID\n' });

    const result = await promise;
    expect(result.stdout).toBe('CONTAINER ID\n');
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it('captures a non-zero exit code and stderr without throwing', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);

    const promise = runDocker(['inspect', 'missing']);
    finish(child, { stderr: 'Error: No such object: missing\n', code: 1 });

    const result = await promise;
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('No such object');
  });

  it('kills the process and reports timedOut after the timeout elapses', async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild();
      spawnMock.mockReturnValue(child);

      const promise = runDocker(['exec', 'stuck', 'sleep', '999'], { timeoutMs: 5000 });
      await vi.advanceTimersByTimeAsync(5000);
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');

      finish(child, { code: -1 });
      const result = await promise;
      expect(result.timedOut).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('writes stdin when given, for the base64 write-file pattern', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);

    const promise = runDocker(['exec', '-i', 'x', 'sh'], { stdin: 'aGVsbG8=' });
    expect(child.stdin.end).toHaveBeenCalledWith('aGVsbG8=');
    finish(child);
    await promise;
  });

  it('rejects when the docker binary cannot be spawned at all', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);

    const promise = runDocker(['ps']);
    child.emit('error', new Error('ENOENT'));

    await expect(promise).rejects.toThrow('ENOENT');
  });
});

describe('dockerAvailable', () => {
  it('reports ok when `docker info` exits 0', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);
    const promise = dockerAvailable();
    finish(child, { code: 0 });
    expect(await promise).toEqual({ ok: true });
  });

  it('reports not-ok with an actionable reason when docker is installed but not running', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);
    const promise = dockerAvailable();
    finish(child, { code: 1, stderr: 'Cannot connect to the Docker daemon' });
    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not running/i);
  });

  it('reports not-ok with an actionable reason when the binary itself is missing', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);
    const promise = dockerAvailable();
    child.emit('error', new Error('ENOENT'));
    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not installed/i);
  });
});

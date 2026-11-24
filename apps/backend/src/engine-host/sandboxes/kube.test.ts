import { ReadStream, WriteStream } from 'fs';
import { mkdtemp, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import type { Followed, ProcessResult } from '../../platform/index.js';
import { applyWorkspace, createKubeRunner, createKubeStreamer, MAX_OUTPUT_CHARS, onKoalasCluster, type ClusterStarter, type KoalasCluster, type KubeRunner } from './kube.js';

interface Held extends Followed {
  stop: Mock<() => void>;
  end(result: Partial<ProcessResult>): void;
  fail(err: Error): void;
}

const held = (): Held => {
  let end: (result: ProcessResult) => void = () => undefined;
  let fail: (err: Error) => void = () => undefined;
  const ended = new Promise<ProcessResult>((done, failed) => { end = done; fail = failed; });
  return { pid: undefined, stop: vi.fn<() => void>(), exited: ended, ended, end: (result) => end({ code: 0, stdout: '', stderr: '', ...result }), fail: (err) => fail(err) };
};

const answering = (followed: Held): MockProxy<KoalasCluster> => {
  const cluster = mock<KoalasCluster>();
  cluster.start.mockResolvedValue(followed);
  return cluster;
};

const tick = (): Promise<void> => new Promise((settle) => setTimeout(settle, 0));

afterEach(() => { vi.useRealTimers(); });

describe('the sandbox runner on Koala\'s own cluster', () => {
  it('binds every call to Koala\'s cluster through ClusterAccess', async () => {
    const access = mock<ClusterStarter>();
    const followed = held();
    access.start.mockResolvedValue(followed);
    expect(await onKoalasCluster(access, () => 'machine-dev1').start(['get', 'pods'], { input: 'x' })).toBe(followed);
    expect(access.start).toHaveBeenCalledWith('machine-dev1', ['get', 'pods'], { input: 'x' });
  });

  it('starts kubectl with the call\'s arguments and nothing on its input when given none, and answers how it ended', async () => {
    const followed = held();
    const cluster = answering(followed);
    const running = createKubeRunner(cluster)(['get', 'ns']);
    await tick();
    followed.end({ code: 3, stdout: 'out', stderr: 'err' });
    expect(await running).toEqual({ stdout: 'out', stderr: 'err', exitCode: 3 });
    expect(cluster.start).toHaveBeenCalledWith(['get', 'ns'], {});
  });

  it('hands its input to kubectl', async () => {
    const followed = held();
    const cluster = answering(followed);
    const running = createKubeRunner(cluster)(['apply', '-f', '-'], 'kind: Namespace');
    await tick();
    followed.end({});
    await running;
    expect(cluster.start).toHaveBeenCalledWith(['apply', '-f', '-'], { input: 'kind: Namespace' });
  });

  it('keeps as much of what was printed as the caller asked, and no more of stderr than the cap', async () => {
    const short = held();
    const shortRun = createKubeRunner(answering(short))(['logs'], undefined, undefined, { outputChars: 3 });
    await tick();
    short.end({ stdout: 'abcdef', stderr: 'e'.repeat(MAX_OUTPUT_CHARS + 5) });
    const cut = await shortRun;
    expect(cut.stdout).toBe('abc');
    expect(cut.stderr).toHaveLength(MAX_OUTPUT_CHARS);

    const whole = held();
    const wholeRun = createKubeRunner(answering(whole))(['logs'], undefined, undefined, { outputChars: Infinity });
    await tick();
    whole.end({ stdout: 'x'.repeat(MAX_OUTPUT_CHARS + 10) });
    expect((await wholeRun).stdout).toHaveLength(MAX_OUTPUT_CHARS + 10);

    const capped = held();
    const cappedRun = createKubeRunner(answering(capped))(['logs']);
    await tick();
    capped.end({ stdout: 'x'.repeat(MAX_OUTPUT_CHARS + 10) });
    expect((await cappedRun).stdout).toHaveLength(MAX_OUTPUT_CHARS);
  });

  it('stops a call at the limit its caller set, the clean-up first and kubectl only after it, and says it was the limit', async () => {
    vi.useFakeTimers();
    const followed = held();
    const order: string[] = [];
    followed.stop.mockImplementation(() => { order.push('kubectl stopped'); followed.end({ code: 128, stdout: 'started' }); });
    const running = createKubeRunner(answering(followed))(['exec'], undefined, 200, {
      onStop: async (why) => { order.push(`clean-up for ${why}`); },
    });
    await vi.advanceTimersByTimeAsync(200);
    const result = await running;
    expect(result).toEqual({ stdout: 'started', stderr: '', exitCode: 128, stopped: 'timeout' });
    expect(order).toEqual(['clean-up for timeout', 'kubectl stopped']);
  });

  it('stops a call when its run is cancelled, and only once however often it is told', async () => {
    const followed = held();
    followed.stop.mockImplementation(() => followed.end({ code: 128 }));
    const stop = new AbortController();
    const onStop = vi.fn(async () => undefined);
    const running = createKubeRunner(answering(followed))(['exec'], undefined, 60_000, { signal: stop.signal, onStop });
    await tick();
    stop.abort();
    stop.abort();
    expect((await running).stopped).toBe('cancelled');
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onStop).toHaveBeenCalledWith('cancelled');
    expect(followed.stop).toHaveBeenCalledTimes(1);
  });

  it('stops at once a call whose run was cancelled before kubectl started', async () => {
    const followed = held();
    followed.stop.mockImplementation(() => followed.end({ code: 128 }));
    const stop = new AbortController();
    stop.abort();
    expect((await createKubeRunner(answering(followed))(['exec'], undefined, undefined, { signal: stop.signal })).stopped).toBe('cancelled');
    expect(followed.stop).toHaveBeenCalled();
  });

  it('still lets go of kubectl when the clean-up fails, and says what may still run', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const followed = held();
    followed.stop.mockImplementation(() => followed.end({ code: 128 }));
    const stop = new AbortController();
    const running = createKubeRunner(answering(followed))(['exec'], undefined, undefined, { signal: stop.signal, onStop: async () => { throw new Error('the pod is gone'); } });
    await tick();
    stop.abort();
    expect((await running).stopped).toBe('cancelled');
    expect(warned).toHaveBeenCalledWith(expect.stringContaining('the pod is gone'));
    warned.mockRestore();
  });

  it('lets a call with no limit and no signal run until it ends, never stopping it', async () => {
    vi.useFakeTimers();
    const followed = held();
    const running = createKubeRunner(answering(followed))(['exec']);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    followed.end({ stdout: 'done' });
    expect(await running).toEqual({ stdout: 'done', stderr: '', exitCode: 0 });
    expect(followed.stop).not.toHaveBeenCalled();
  });

  it('fails with ClusterAccess\'s reason when Koala\'s cluster cannot be reached, and when kubectl cannot start', async () => {
    const cluster = mock<KoalasCluster>();
    cluster.start.mockRejectedValue(new Error('this process is not running inside Koala\'s cluster'));
    await expect(createKubeRunner(cluster)(['get', 'ns'])).rejects.toThrow('not running inside Koala\'s cluster');
    const followed = held();
    const running = createKubeRunner(answering(followed))(['get', 'ns']);
    await tick();
    followed.fail(new Error('spawn kubectl ENOENT'));
    await expect(running).rejects.toThrow('ENOENT');
  });
});

describe('streaming files through Koala\'s own cluster', () => {
  it('streams what kubectl prints into the file named, and answers how it ended', async () => {
    const folder = await mkdtemp(path.join(os.tmpdir(), 'koala-kube-'));
    const followed = held();
    const cluster = answering(followed);
    const saving = createKubeStreamer(cluster).toFile(['exec', 'pod'], path.join(folder, 'bundle'));
    await tick();
    followed.end({ code: 1, stderr: 'e'.repeat(MAX_OUTPUT_CHARS + 1) });
    const result = await saving;
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toHaveLength(MAX_OUTPUT_CHARS);
    const io = cluster.start.mock.calls[0]?.[1];
    expect(io?.output).toBeInstanceOf(WriteStream);
    expect((io?.output as WriteStream).path).toBe(path.join(folder, 'bundle'));
    (io?.output as WriteStream).destroy();
  });

  it('lets go of the file when Koala\'s cluster cannot be reached', async () => {
    const folder = await mkdtemp(path.join(os.tmpdir(), 'koala-kube-'));
    const cluster = mock<KoalasCluster>();
    let output: WriteStream | undefined;
    cluster.start.mockImplementation(async (_args, io) => { output = io?.output as WriteStream; throw new Error('there is no cluster machine-gone'); });
    await expect(createKubeStreamer(cluster).toFile(['exec'], path.join(folder, 'bundle'))).rejects.toThrow('there is no cluster machine-gone');
    expect(output?.destroyed).toBe(true);
  });

  it('streams the file named into kubectl and answers what the pod said back', async () => {
    const folder = await mkdtemp(path.join(os.tmpdir(), 'koala-kube-'));
    await writeFile(path.join(folder, 'bundle'), 'bytes');
    const followed = held();
    const cluster = answering(followed);
    const sending = createKubeStreamer(cluster).fromFile(['exec', '-i', 'pod'], path.join(folder, 'bundle'));
    await tick();
    followed.end({ stdout: '5\n' });
    expect(await sending).toEqual({ exitCode: 0, stdout: '5\n', stderr: '' });
    const io = cluster.start.mock.calls[0]?.[1];
    expect(io?.input).toBeInstanceOf(ReadStream);
    expect((io?.input as ReadStream).path).toBe(path.join(folder, 'bundle'));
    (io?.input as ReadStream).destroy();
  });
});

describe('waiting for a workspace pod just applied', () => {
  const ready = JSON.stringify({ status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }], containerStatuses: [{ name: 'workspace', ready: true, state: { running: {} } }] } });
  const answering = (reads: { stdout?: string; stderr?: string; exitCode: number }[]): KubeRunner => {
    const left = [...reads];
    return async (args) => {
      if (args[0] === 'apply') return { stdout: '', stderr: '', exitCode: 0 };
      const next = left.shift();
      if (!next) throw new Error('the workspace was read again after an answer it should have ended on');
      return { stdout: '', stderr: '', ...next };
    };
  };
  const applying = (run: KubeRunner) => applyWorkspace(run, { manifests: [], namespace: 'koala-run-tree-t1', pod: 'workspace', pollMs: 1 });

  it('waits while the cluster does not answer for now, and ends once the pod is ready', async () => {
    await expect(applying(answering([{ stderr: 'The connection to the server 127.0.0.1:6443 was refused - did you specify the right host or port?', exitCode: 1 }, { stdout: ready, exitCode: 0 }]))).resolves.toBeUndefined();
  });

  it('ends at once with why when the pod it applied is gone, or its pod could not be read at all, as when its run was stopped', async () => {
    await expect(applying(answering([{ stderr: 'Error from server (NotFound): pods "workspace" not found', exitCode: 1 }]))).rejects.toThrow('The workspace\'s pod could not be read: Error from server (NotFound): pods "workspace" not found');
    await expect(applying(answering([{ stderr: '', exitCode: 137 }]))).rejects.toThrow('The workspace\'s pod could not be read: kubectl ended with 137 and said nothing');
  });
});

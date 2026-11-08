import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProcessFailed, succeeded } from '../lib/processes.js';
import { nodeProcesses, nodeStreams } from './processes.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

function program(happens: (child: ChildProcess & { stdout: EventEmitter; stderr: EventEmitter }) => void) {
  const stdin = new PassThrough();
  vi.spyOn(stdin, 'end');
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), stdin }) as unknown as ChildProcess & { stdout: EventEmitter; stderr: EventEmitter };
  vi.mocked(spawn).mockImplementationOnce(() => {
    queueMicrotask(() => happens(child));
    return child;
  });
  return { stdin };
}

describe('running a program on this machine', () => {
  beforeEach(() => vi.mocked(spawn).mockReset());

  it('hands back what it printed and how it exited, without a shell between', async () => {
    program((child) => {
      child.stdout.emit('data', Buffer.from('a b|'));
      child.stdout.emit('data', Buffer.from('$HOME|'));
      child.stderr.emit('data', Buffer.from('oops'));
      child.emit('close', 3, null);
    });
    expect(await nodeProcesses.run({ command: 'sh', args: ['-c', 'ignored'] })).toEqual({ code: 3, stdout: 'a b|$HOME|', stderr: 'oops' });
    expect(vi.mocked(spawn).mock.calls[0]?.slice(0, 2)).toEqual(['sh', ['-c', 'ignored']]);
  });

  it('passes its input, folder and environment on top of its own', async () => {
    const { stdin } = program((child) => child.emit('close', 0, null));
    await nodeProcesses.run({ command: 'cat', args: [], input: 'in\n', cwd: '/work', env: { WHO: 'koala' } });
    expect(stdin.end).toHaveBeenCalledWith('in\n');
    const options = vi.mocked(spawn).mock.calls[0]?.[2] as { cwd?: string; env?: Record<string, string | undefined> };
    expect(options.cwd).toBe('/work');
    expect(options.env?.WHO).toBe('koala');
    expect(options.env?.PATH).toBe(process.env.PATH);
  });

  it('closes its input with nothing when it was given none', async () => {
    const { stdin } = program((child) => child.emit('close', 0, null));
    await nodeProcesses.run({ command: 'true', args: [] });
    expect(stdin.end).toHaveBeenCalledWith();
  });

  it('answers with the exit of a program that stops before reading what it was given', async () => {
    const { stdin } = program((child) => {
      stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
      child.emit('close', 4, null);
    });
    expect((await nodeProcesses.run({ command: 'sh', args: ['-c', 'exit 4'], input: 'unread' })).code).toBe(4);
  });

  it('says it exited 128 when a signal ended it, or 1 when it said nothing at all', async () => {
    program((child) => child.emit('close', null, 'SIGKILL'));
    expect((await nodeProcesses.run({ command: 'sleep', args: ['9'] })).code).toBe(128);
    program((child) => child.emit('close', null, null));
    expect((await nodeProcesses.run({ command: 'sleep', args: ['9'] })).code).toBe(1);
  });

  it('rejects when the program cannot be started at all', async () => {
    program((child) => child.emit('error', Object.assign(new Error('spawn no-such-program-koala ENOENT'), { code: 'ENOENT' })));
    await expect(nodeProcesses.run({ command: 'no-such-program-koala', args: [] })).rejects.toThrow(/ENOENT/);
  });

  it('turns a failed exit into an error naming the command and what it said', async () => {
    const failing = () => program((child) => {
      child.stderr.emit('data', Buffer.from('nope\n'));
      child.emit('close', 2, null);
    });
    failing();
    await expect(succeeded(nodeProcesses, { command: 'sh', args: ['-c', 'echo nope >&2; exit 2'] })).rejects.toThrow(ProcessFailed);
    failing();
    await expect(succeeded(nodeProcesses, { command: 'sh', args: ['-c', 'echo nope >&2; exit 2'] })).rejects.toThrow('sh -c echo nope >&2; exit 2 exited 2: nope');
    program((child) => {
      child.stdout.emit('data', Buffer.from('fine\n'));
      child.emit('close', 0, null);
    });
    expect(await succeeded(nodeProcesses, { command: 'echo', args: ['fine'] })).toBe('fine\n');
  });
});

function started(happens: (child: ChildProcess & { stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> }) => void) {
  const stdin = new PassThrough();
  vi.spyOn(stdin, 'end');
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin, kill: vi.fn() }) as unknown as ChildProcess & { stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> };
  vi.mocked(spawn).mockImplementationOnce(() => {
    queueMicrotask(() => happens(child));
    return child;
  });
  return { stdin, child };
}

const sink = (): { stream: Writable; bytes: () => Buffer } => {
  const chunks: Buffer[] = [];
  const stream = new Writable({ write(chunk: Buffer, _encoding, done) { chunks.push(chunk); done(); } });
  return { stream, bytes: () => Buffer.concat(chunks) };
};

describe('starting a program that can be stopped and streamed', () => {
  beforeEach(() => vi.mocked(spawn).mockReset());

  it('hands back what it printed and how it exited', async () => {
    started((child) => {
      child.stdout.write('out');
      child.stderr.write('err');
      setTimeout(() => child.emit('close', 2, null), 5);
    });
    expect(await nodeStreams.start({ command: 'sh', args: ['-c', 'x'] }).ended).toEqual({ code: 2, stdout: 'out', stderr: 'err' });
    expect(vi.mocked(spawn).mock.calls[0]?.slice(0, 2)).toEqual(['sh', ['-c', 'x']]);
  });

  it('closes its input with nothing when it was given none, and with the text when given text', async () => {
    const quiet = started((child) => child.emit('close', 0, null));
    await nodeStreams.start({ command: 'true', args: [] }).ended;
    expect(quiet.stdin.end).toHaveBeenCalledWith();
    const told = started((child) => child.emit('close', 0, null));
    await nodeStreams.start({ command: 'cat', args: [] }, { input: 'hello' }).ended;
    expect(told.stdin.end).toHaveBeenCalledWith('hello');
    const fromRun = started((child) => child.emit('close', 0, null));
    await nodeStreams.start({ command: 'cat', args: [], input: 'from the run' }).ended;
    expect(fromRun.stdin.end).toHaveBeenCalledWith('from the run');
  });

  it('pipes a stream it was given into the program', async () => {
    const read: Buffer[] = [];
    const { stdin } = started((child) => {
      stdin.on('data', (chunk: Buffer) => read.push(chunk));
      stdin.on('end', () => child.emit('close', 0, null));
    });
    const input = new PassThrough();
    const running = nodeStreams.start({ command: 'cat', args: [] }, { input });
    input.end(Buffer.from([0, 1, 2, 255]));
    await running.ended;
    expect(Buffer.concat(read)).toEqual(Buffer.from([0, 1, 2, 255]));
  });

  it('writes what it prints, bytes as they are, to the output it was given, and ends once that output has everything', async () => {
    const out = sink();
    started((child) => {
      child.stdout.end(Buffer.from([0, 200, 10, 255]));
      child.emit('close', 0, null);
    });
    const result = await nodeStreams.start({ command: 'cat', args: [] }, { output: out.stream }).ended;
    expect(result).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(out.bytes()).toEqual(Buffer.from([0, 200, 10, 255]));
  });

  it('kills the program when stopped, and says a signal ended it', async () => {
    const { child } = started(() => undefined);
    const running = nodeStreams.start({ command: 'sleep', args: ['9'] });
    await new Promise((settle) => setTimeout(settle, 0));
    running.stop();
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    child.emit('close', null, 'SIGKILL');
    expect((await running.ended).code).toBe(128);
  });

  it('rejects when the program cannot be started at all', async () => {
    started((child) => child.emit('error', Object.assign(new Error('spawn no-such-program-koala ENOENT'), { code: 'ENOENT' })));
    await expect(nodeStreams.start({ command: 'no-such-program-koala', args: [] }).ended).rejects.toThrow(/ENOENT/);
  });

  it('kills the program and rejects when the stream it reads from fails', async () => {
    const { child } = started(() => undefined);
    const input = new PassThrough();
    const running = nodeStreams.start({ command: 'cat', args: [] }, { input });
    await new Promise((settle) => setTimeout(settle, 0));
    input.emit('error', new Error('the file went away'));
    await expect(running.ended).rejects.toThrow('the file went away');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('answers with the exit of a program that stops reading, and rejects on any other failure to write to it', async () => {
    const unread = started((child) => {
      unread.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
      child.emit('close', 4, null);
    });
    expect((await nodeStreams.start({ command: 'sh', args: [] }, { input: 'x' }).ended).code).toBe(4);
    const broken = started(() => {
      broken.stdin.emit('error', Object.assign(new Error('write EIO'), { code: 'EIO' }));
    });
    await expect(nodeStreams.start({ command: 'sh', args: [] }, { input: 'x' }).ended).rejects.toThrow('EIO');
  });
});

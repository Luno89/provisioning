import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProcessFailed, succeeded } from '../lib/processes.js';
import { nodeProcesses } from './processes.js';

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

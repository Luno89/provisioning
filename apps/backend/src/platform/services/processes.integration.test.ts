import { describe, expect, it } from 'vitest';
import { ProcessFailed, succeeded } from '../lib/processes.js';
import { nodeProcesses } from './processes.js';

describe('running a program on this machine', () => {
  it('hands back what it printed and how it exited, without a shell between', async () => {
    expect(await nodeProcesses.run({ command: 'sh', args: ['-c', 'printf "%s|" "$@"; printf oops >&2; exit 3', 'sh', 'a b', '$HOME'] })).toEqual({ code: 3, stdout: 'a b|$HOME|', stderr: 'oops' });
  });

  it('passes its input, folder and environment', async () => {
    expect(await nodeProcesses.run({ command: 'sh', args: ['-c', 'cat; pwd; printf "$WHO"'], input: 'in\n', cwd: '/tmp', env: { WHO: 'koala' } })).toMatchObject({ code: 0, stdout: 'in\n/tmp\nkoala' });
  });

  it('rejects when the program cannot be started at all', async () => {
    await expect(nodeProcesses.run({ command: 'no-such-program-koala', args: [] })).rejects.toThrow(/ENOENT/);
  });

  it('turns a failed exit into an error naming the command and what it said', async () => {
    await expect(succeeded(nodeProcesses, { command: 'sh', args: ['-c', 'echo nope >&2; exit 2'] })).rejects.toThrow(ProcessFailed);
    await expect(succeeded(nodeProcesses, { command: 'sh', args: ['-c', 'echo nope >&2; exit 2'] })).rejects.toThrow('sh -c echo nope >&2; exit 2 exited 2: nope');
    expect(await succeeded(nodeProcesses, { command: 'echo', args: ['fine'] })).toBe('fine\n');
  });
});

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { processesContract } from '../testing/processes-contract.js';
import { ProcessFailed, succeeded } from './processes.js';
import { nodeProcesses, nodeStreams, spawnedProcesses, withEnvironment } from './node-processes.js';

processesContract('spawnedProcesses', () => spawnedProcesses(withEnvironment(process.env)));

describe('running a program on this machine', () => {
  it('hands back what it printed and how it exited, without a shell between', async () => {
    expect(await nodeProcesses.run({ command: 'sh', args: ['-c', 'printf "%s|" "$@"; printf oops >&2; exit 3', 'sh', 'a b', '$HOME'] })).toEqual({ code: 3, stdout: 'a b|$HOME|', stderr: 'oops' });
  });

  it('passes its input, folder and environment', async () => {
    expect(await nodeProcesses.run({ command: 'sh', args: ['-c', 'cat; pwd; printf "$WHO"'], input: 'in\n', cwd: '/tmp', env: { WHO: 'koala' } })).toMatchObject({ code: 0, stdout: 'in\n/tmp\nkoala' });
  });

  it('answers with the exit of a program that stops before reading what it was given', async () => {
    expect(await nodeProcesses.run({ command: 'sh', args: ['-c', 'exit 4'], input: 'x'.repeat(1 << 20) })).toMatchObject({ code: 4 });
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

describe('streaming a program on this machine', () => {
  it('starts a program, hands back what it printed, and passes text it was given', async () => {
    expect(await nodeStreams.start({ command: 'sh', args: ['-c', 'cat; echo bad >&2; exit 5'] }, { input: 'in' }).ended).toEqual({ code: 5, stdout: 'in', stderr: 'bad\n' });
  });

  it('streams a file in and the bytes out to a file, unchanged', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'koala-streams-'));
    const bytes = Buffer.from(Array.from({ length: 70_000 }, (_, at) => at % 256));
    await writeFile(join(folder, 'in'), bytes);
    const result = await nodeStreams.start({ command: 'cat', args: [] }, { input: createReadStream(join(folder, 'in')), output: createWriteStream(join(folder, 'out')) }).ended;
    expect(result.code).toBe(0);
    expect(await readFile(join(folder, 'out'))).toEqual(bytes);
  });

  it('stops a program that would run on', async () => {
    const running = nodeStreams.start({ command: 'sleep', args: ['30'] });
    setTimeout(() => running.stop(), 50);
    expect((await running.ended).code).toBe(128);
  });

  it('follows text whose characters fall across the chunks it arrives in', async () => {
    const said: string[] = [];
    const followed = nodeStreams.follow({ command: 'sh', args: ['-c', 'printf "\\342"; sleep 0.1; printf "\\202\\254"'] }, (chunk) => said.push(chunk));
    expect((await followed.ended).code).toBe(0);
    expect(said.join('')).toBe('\u20ac');
  });
});

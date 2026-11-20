import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { ProcessFailed, ProcessNotStarted, succeeded, type ProcessRun, type Processes, type Streams } from '../src/processes.js';

export const CONTRACT = {
  bothStreams: { command: 'sh', args: ['-c', 'printf "one\\ntwo\\n"; printf "three\\n" >&2'] },
  failing: { command: 'sh', args: ['-c', 'echo before; echo nope >&2; exit 3'] },
  echoed: { command: 'cat', args: [], input: 'piped\nin' },
  withEnv: { command: 'sh', args: ['-c', 'echo "$KOALA_PROCESS_SAID"'], env: { KOALA_PROCESS_SAID: 'hello' } },
  inFolder: { command: 'pwd', args: [], cwd: '/' },
  killed: { command: 'sh', args: ['-c', 'kill -KILL $$'] },
  missing: { command: 'koala-process-no-such-program', args: [] },
  bytes: { command: 'printf', args: ['\\000\\310\\n\\377'] },
  waits: { command: 'sleep', args: ['100000'] },
  family: { command: 'sh', args: ['-c', 'sleep 100000 & wait'] },
  leavesFamily: { command: 'sh', args: ['-c', 'sleep 100000 & exit 4'] },
} as const satisfies Record<string, ProcessRun>;

const sink = (): { stream: Writable; bytes: () => Buffer } => {
  const chunks: Buffer[] = [];
  const stream = new Writable({ write(chunk: Buffer, _encoding, done) { chunks.push(chunk); done(); } });
  return { stream, bytes: () => Buffer.concat(chunks) };
};

const rejection = async (running: Promise<unknown>): Promise<unknown> => running.then(() => undefined, (thrown: unknown) => thrown);

export function processesContract(name: string, make: () => Processes & Streams): void {
  describe(`${name} running programs`, () => {
    it('hands back what a program printed to each output and how it exited, without a shell between', async () => {
      expect(await make().run(CONTRACT.bothStreams)).toEqual({ code: 0, stdout: 'one\ntwo\n', stderr: 'three\n' });
    });

    it('lets the caller hear each output as the program prints it', async () => {
      const heard = { stdout: '', stderr: '' };
      await make().run(CONTRACT.bothStreams, { stdout: (chunk) => { heard.stdout += chunk; }, stderr: (chunk) => { heard.stderr += chunk; } });
      expect(heard).toEqual({ stdout: 'one\ntwo\n', stderr: 'three\n' });
    });

    it('answers a failed exit with its code, and succeeded turns it into an error naming the command and what it said', async () => {
      expect(await make().run(CONTRACT.failing)).toEqual({ code: 3, stdout: 'before\n', stderr: 'nope\n' });
      const failure = await rejection(succeeded(make(), CONTRACT.failing));
      expect(failure).toBeInstanceOf(ProcessFailed);
      expect((failure as Error).message).toBe('sh -c echo before; echo nope >&2; exit 3 exited 3: nope');
    });

    it('gives the program its input, its environment and its folder', async () => {
      const processes = make();
      expect((await processes.run(CONTRACT.echoed)).stdout).toBe('piped\nin');
      expect((await processes.run(CONTRACT.withEnv)).stdout).toBe('hello\n');
      expect((await processes.run(CONTRACT.inFolder)).stdout).toBe('/\n');
    });

    it('says which signal ended a program', async () => {
      expect(await make().run(CONTRACT.killed)).toMatchObject({ code: 128, signal: 'SIGKILL' });
    });

    it('rejects a program that is not there, saying it could not start', async () => {
      const failure = await rejection(make().run(CONTRACT.missing));
      expect(failure).toBeInstanceOf(ProcessNotStarted);
      expect((failure as Error).message).toContain('koala-process-no-such-program');
    });
  });

  describe(`${name} streaming programs`, () => {
    it('pipes a stream into a program', async () => {
      const input = new PassThrough();
      const running = make().pipe({ command: 'cat', args: [] }, input);
      input.end('streamed in');
      expect(await running).toEqual({ code: 0, stdout: 'streamed in', stderr: '' });
    });

    it('follows what a program prints until it ends', async () => {
      let said = '';
      const followed = make().follow(CONTRACT.bothStreams, (chunk) => { said += chunk; });
      expect(await followed.ended).toMatchObject({ code: 0, stderr: 'three\n' });
      expect(said).toBe('one\ntwo\n');
    });

    it('starts a program with text or a stream for its input', async () => {
      const streams = make();
      expect((await streams.start({ command: 'cat', args: [] }, { input: 'told' }).ended).stdout).toBe('told');
      const input = new PassThrough();
      const running = streams.start({ command: 'cat', args: [] }, { input });
      input.end('streamed');
      expect((await running.ended).stdout).toBe('streamed');
    });

    it('writes what a program prints, bytes as they are, to the output it was given', async () => {
      const out = sink();
      expect(await make().start(CONTRACT.bytes, { output: out.stream }).ended).toEqual({ code: 0, stdout: '', stderr: '' });
      expect(out.bytes()).toEqual(Buffer.from([0, 200, 10, 255]));
    });

    it('hands both outputs straight to a file it was given, so they reach it even while this process is busy', async () => {
      const folder = mkdtempSync(join(tmpdir(), 'koala-processes-'));
      const fd = openSync(join(folder, 'said'), 'w');
      const result = await make().start(CONTRACT.bothStreams, { outputFd: fd }).ended;
      closeSync(fd);
      const said = readFileSync(join(folder, 'said'), 'utf8');
      rmSync(folder, { recursive: true, force: true });
      expect(result).toEqual({ code: 0, stdout: '', stderr: '' });
      expect([...said.split('\n')].sort()).toEqual(['', 'one', 'three', 'two']);
    });

    it('stops a program that would run on, and says the signal that ended it', async () => {
      const running = make().start(CONTRACT.waits);
      running.stop();
      expect(await running.ended).toMatchObject({ code: 128, signal: 'SIGKILL' });
    });

    it('stops a program and everything it started when it runs as a group, with the signal asked for', async () => {
      const running = make().start(CONTRACT.family, { group: true });
      running.stop('SIGTERM');
      expect(await running.ended).toMatchObject({ code: 128, signal: 'SIGTERM' });
    });

    it('says a program has exited while what it started still holds its output, and stopping the group then ends it', async () => {
      const running = make().start(CONTRACT.leavesFamily, { group: true });
      expect(await running.exited).toEqual({ code: 4 });
      running.stop('SIGTERM');
      expect(await running.ended).toMatchObject({ code: 4 });
    });

    it('rejects a started program that is not there', async () => {
      const running = make().start(CONTRACT.missing);
      expect(await rejection(running.ended)).toBeInstanceOf(ProcessNotStarted);
      expect(await rejection(running.exited)).toBeInstanceOf(ProcessNotStarted);
    });
  });
}

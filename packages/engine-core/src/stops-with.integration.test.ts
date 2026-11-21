import { readFileSync } from 'node:fs';
import { CancelledFailure } from '@temporalio/common';
import { describe, expect, it } from 'vitest';
import { nodeRunner, nodeStreams } from './node-processes.js';
import { killOnCancel, stopsWith } from './stops-with.js';

const alive = (pid: number): boolean => {
  try {
    return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.[0] !== 'Z';
  } catch {
    return false;
  }
};

const dies = async (pid: number): Promise<true> => {
  while (alive(pid)) await new Promise((next) => setImmediate(next));
  return true;
};

describe('a program started for a piece of work that is cancelled', () => {
  it('is killed at once when the work is cancelled, its whole group with it', async () => {
    const stop = new AbortController();
    let said = '';
    let told!: (pid: number) => void;
    const grandchild = new Promise<number>((found) => { told = found; });
    const running = stopsWith(stop.signal, () => nodeStreams.start({ command: 'sh', args: ['-c', 'sleep 600 & echo $!; wait'] }, {
      group: true,
      heard: { stdout: (chunk) => { said += chunk; if (said.includes('\n')) told(Number(said.trim())); } },
    }));
    const pid = await grandchild;
    expect(alive(pid)).toBe(true);
    stop.abort('the project is being deleted');
    expect(await running.exited).toMatchObject({ signal: 'SIGKILL' });
    expect(await dies(pid)).toBe(true);
  });

  it('is killed before it runs at all when the work was already cancelled', async () => {
    const stop = new AbortController();
    stop.abort('the project is being deleted');
    const ended = await stopsWith(stop.signal, () => nodeRunner.run({ command: 'sleep', args: ['600'] }));
    expect(ended).toMatchObject({ signal: 'SIGKILL' });
  });

  it('kills what an activity started once Temporal cancels the activity', async () => {
    const stop = new AbortController();
    const [interceptor] = [killOnCancel()];
    const { inbound } = interceptor!({ cancellationSignal: stop.signal } as never);
    const ran = inbound.execute({}, async () => {
      const running = nodeStreams.start({ command: 'sleep', args: ['600'] });
      stop.abort('cancelled');
      return running.exited;
    });
    expect(await ran).toMatchObject({ signal: 'SIGKILL' });
  });

  it('names the programs it killed in the cancellation it reports to Temporal', async () => {
    const stop = new AbortController();
    const { inbound } = killOnCancel()({ cancellationSignal: stop.signal, cancellationDetails: { cancelRequested: true } } as never);
    const ran = inbound.execute({}, async () => {
      const terraform = nodeStreams.start({ command: '/bin/sleep', args: ['600'] });
      const helm = nodeStreams.start({ command: 'sh', args: ['-c', 'sleep 600'] });
      stop.abort('cancelled');
      await Promise.all([terraform.exited, helm.exited]);
      throw new Error('the program was killed');
    });
    const reported = await ran.catch((err: unknown) => err);
    expect(reported).toBeInstanceOf(CancelledFailure);
    expect((reported as CancelledFailure).details).toEqual([{ killed: ['sleep', 'sh'] }]);
  });

  it('leaves alone a program whose work goes on', async () => {
    const stop = new AbortController();
    const ended = await stopsWith(stop.signal, () => nodeRunner.run({ command: 'echo', args: ['done'] }));
    expect(ended).toMatchObject({ code: 0, stdout: 'done\n' });
  });
});

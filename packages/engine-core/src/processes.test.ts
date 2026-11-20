import { describe, expect, it } from 'vitest';
import type { ProcessRun } from './processes.js';
import { CONTRACT, processesContract } from '../testing/processes-contract.js';
import { recordingProcesses, type Answer } from '../testing/processes.js';

const same = (a: ProcessRun, b: ProcessRun): boolean => a.command === b.command && JSON.stringify(a.args) === JSON.stringify(b.args);

const asShWould = (run: ProcessRun): Answer | undefined => {
  if (same(run, CONTRACT.bothStreams)) return { stdout: 'one\ntwo\n', stderr: 'three\n' };
  if (same(run, CONTRACT.failing)) return { stdout: 'before\n', stderr: 'nope\n', code: 3 };
  if (same(run, CONTRACT.echoed)) return { stdout: (input) => input };
  if (same(run, CONTRACT.withEnv)) return { stdout: `${run.env?.['KOALA_PROCESS_SAID'] ?? ''}\n` };
  if (same(run, CONTRACT.inFolder)) return { stdout: `${run.cwd ?? ''}\n` };
  if (same(run, CONTRACT.leavesFamily)) return { code: 4 };
  if (same(run, CONTRACT.killed)) return { signal: 'SIGKILL' };
  if (same(run, CONTRACT.bytes)) return { stdout: Buffer.from([0, 200, 10, 255]) };
  if (same(run, CONTRACT.waits) || same(run, CONTRACT.family)) return { runsUntilStopped: true };
  return undefined;
};

processesContract('recordingProcesses', () => recordingProcesses(asShWould));

describe('recordingProcesses', () => {
  it('keeps every program it was asked to run, in order, with the input it was given', async () => {
    const processes = recordingProcesses(() => ({}));
    await processes.run({ command: 'git', args: ['status'] });
    await processes.run({ command: 'cat', args: [], input: 'told' });
    expect(processes.ran).toEqual([{ command: 'git', args: ['status'] }, { command: 'cat', args: [], input: 'told' }]);
  });

  it('keeps how each started program was stopped', async () => {
    const processes = recordingProcesses(() => ({ runsUntilStopped: true }));
    const running = processes.start({ command: 'terraform', args: ['apply'] }, { group: true });
    running.stop('SIGINT');
    await running.ended;
    expect(processes.recorded).toEqual([{ run: { command: 'terraform', args: ['apply'] }, io: { group: true }, stoppedWith: 'SIGINT' }]);
  });
});

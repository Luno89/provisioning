import { describe, expect, it } from 'vitest';
import { recordingProcesses } from '../testing/processes.js';
import { execForModel, NOT_FOUND_EXIT, STOPPED_EXIT } from './model-exec.js';

const shellOver = (streams: ReturnType<typeof recordingProcesses>) => ({ streams, shell: ['/bin/bash', '-lc'], cwd: '/work', env: { HOME: '/home/person' } });

describe('a command a model runs', () => {
  it('runs in the shell it was given, in its folder, as a group, and answers what it printed and how it exited', async () => {
    const streams = recordingProcesses(() => ({ stdout: 'built\n', stderr: 'warned\n', code: 2 }));
    expect(await execForModel(shellOver(streams), { command: 'make', env: { CI: '1' } })).toEqual({ stdout: 'built\n', stderr: 'warned\n', exitCode: 2 });
    expect(streams.recorded).toEqual([{ run: { command: '/bin/bash', args: ['-lc', 'make'], cwd: '/work', env: { HOME: '/home/person', CI: '1' } }, io: { group: true } }]);
  });

  it('is stopped at the limit the person set, and says so', async () => {
    const streams = recordingProcesses(() => ({ stdout: 'partway\n', runsUntilStopped: true }));
    expect(await execForModel(shellOver(streams), { command: 'sleep 100000', timeoutMs: 0 })).toEqual({ stdout: 'partway\n', stderr: '', exitCode: STOPPED_EXIT, stopped: 'timeout' });
    expect(streams.recorded[0]?.stoppedWith).toBe('SIGTERM');
  });

  it('runs on with no limit when the person set none, until it is cancelled', async () => {
    const streams = recordingProcesses(() => ({ runsUntilStopped: true }));
    const cancel = new AbortController();
    const running = execForModel(shellOver(streams), { command: 'sleep 100000', signal: cancel.signal });
    await new Promise<void>((settle) => { setImmediate(settle); });
    expect(streams.recorded[0]?.stoppedWith).toBeUndefined();
    cancel.abort();
    expect(await running).toMatchObject({ exitCode: STOPPED_EXIT, stopped: 'cancelled' });
  });

  it('says the shell could not start when it is not there', async () => {
    const streams = recordingProcesses(() => undefined);
    expect(await execForModel(shellOver(streams), { command: 'ls' })).toEqual({ stdout: '', stderr: '/bin/bash could not start: spawn /bin/bash ENOENT', exitCode: NOT_FOUND_EXIT });
  });
});

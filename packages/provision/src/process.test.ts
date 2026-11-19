import { describe, expect, it } from 'vitest';
import { recordingProcesses } from '@koala/engine-core/testing/processes';
import { processProvider } from './process.js';

const quiet = { line: () => undefined };

describe('a process of this run', () => {
  it('says how it ended and the last it said, and tells whoever listens', async () => {
    const streams = recordingProcesses(() => ({ stderr: 'starting\naddress already in use\n', code: 48 }));
    const provider = processProvider({ name: 'mongod', command: 'mongod', args: ['--port', '1'] }, streams);
    const heard: string[] = [];
    provider.onEnded((why) => heard.push(why));
    await provider.start({}, quiet);
    expect(await provider.ending!({})).toBe('mongod exited with 48 (last said: starting | address already in use)');
    expect(heard).toEqual(['mongod exited with 48 (last said: starting | address already in use)']);
  });

  it('is stopped with SIGTERM when removed, without telling the listeners it ended', async () => {
    const streams = recordingProcesses(() => ({ runsUntilStopped: true }));
    const provider = processProvider({ name: 'mongod', command: 'mongod', args: [] }, streams);
    const heard: string[] = [];
    provider.onEnded((why) => heard.push(why));
    await provider.start({}, quiet);
    expect(await provider.running({})).toEqual({ done: true });
    await provider.remove!({}, quiet);
    expect(streams.recorded[0]?.stoppedWith).toBe('SIGTERM');
    expect(heard).toEqual([]);
  });

  it('says it could not start when its program is not there', async () => {
    const provider = processProvider({ name: 'mongod', command: 'mongod', args: [] }, recordingProcesses(() => undefined));
    await provider.start({}, quiet);
    expect(await provider.ending!({})).toBe('mongod could not start: spawn mongod ENOENT');
  });
});

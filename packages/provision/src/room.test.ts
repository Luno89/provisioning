import { describe, expect, it } from 'vitest';
import { fakeCommands } from '../testing/fake-commands.js';
import { memoryReporter } from '../testing/memory-reporter.js';
import { stepFailureOf } from '../testing/step-failure.js';
import { bytes, roomStep } from './room.js';
import { runSteps } from './steps.js';

const GB = 1024 ** 3;
const MB = 1024 ** 2;

const du = (listing: string) => fakeCommands((command) => (command.command === 'du' ? { stdout: listing } : undefined));

describe('the room where something writes', () => {
  it('says in its title how much is free and how much is needed, and is done when that fits', async () => {
    const step = await roomStep({ id: 'room', for: 'a test run', path: '/tmp', needs: 2 * GB, free: async () => 20 * GB });
    expect(step.title).toBe('Room in /tmp: 20.0 GB free, 2.0 GB needed for a test run');
    const reporter = memoryReporter();
    await runSteps([step], { commands: du('') }, reporter);
    expect(reporter.reported.map((entry) => entry.kind)).toEqual(['started', 'already-done']);
  });

  it('refuses when less is free than needed, naming what uses the room, largest first', async () => {
    const commands = du(`${3 * GB}\t/tmp/mongo-mem-a\n${12 * GB}\t/tmp/koala-tests\n${5 * MB}\t/tmp/socket-caddy-b\n${17 * GB}\t/tmp\n`);
    const step = await roomStep({ id: 'room', for: 'a test run', path: '/tmp', needs: 2 * GB, free: async () => 30 * MB });
    const failure = await stepFailureOf(runSteps([step], { commands }, memoryReporter()));
    expect(failure.why).toBe('only 30.0 MB is free in /tmp, and 2.0 GB is needed for a test run; using it: /tmp/koala-tests (12.0 GB), /tmp/mongo-mem-a (3.0 GB), /tmp/socket-caddy-b (5.0 MB)');
    expect(commands.ran[0]).toMatchObject({ command: 'du', args: ['-x', '-a', '-b', '-d', '1', '/tmp'] });
  });

  it('writes sizes the way people read them', () => {
    expect([bytes(512), bytes(1536), bytes(30 * MB), bytes(1.25 * GB)]).toEqual(['512 B', '1.5 KB', '30.0 MB', '1.3 GB']);
  });
});

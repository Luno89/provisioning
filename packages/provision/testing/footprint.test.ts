import { describe, expect, it } from 'vitest';
import { roomStep } from '../src/room.js';
import { runSteps } from '../src/steps.js';
import { fakeCommands } from './fake-commands.js';
import { MEASURED_PEAK, RUN_NEEDS } from './footprint.js';
import { memoryReporter } from './memory-reporter.js';

const ran = async (free: number): Promise<string> => {
  const step = await roomStep({ id: 'room', for: 'a test run', path: '/tmp', needs: RUN_NEEDS, free: async () => free });
  return runSteps([step], { commands: fakeCommands(() => ({ stdout: '' })) }, memoryReporter()).then(() => 'ran', (err: Error) => err.message);
};

describe('the room a test run needs', () => {
  it('is the most the backend\'s integration tier held in its run folder at once (sampled every two seconds through a whole run, 2026-11-18), with half again on top for runs that grow', () => {
    expect(MEASURED_PEAK).toBe(1_363_702_193);
    expect(RUN_NEEDS).toBeGreaterThanOrEqual(MEASURED_PEAK * 1.5);
    expect(RUN_NEEDS).toBeLessThan(MEASURED_PEAK * 1.5 + 1024 ** 2);
  });

  it('refuses a disk with only the measured peak free, and runs with what it asks', async () => {
    expect(await ran(MEASURED_PEAK)).toMatch(/is needed for a test run/);
    expect(await ran(RUN_NEEDS)).toBe('ran');
  });
});

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DOWNLOADS_VARIABLE } from '@koala/engine-core/testing/downloads';
import { THIS_CHECKOUT } from '@koala/engine-core/testing/throwaway-containers';
import { localCommands } from '../src/local-commands.js';
import { roomStep } from '../src/room.js';
import { removeSteps, runSteps, type Step } from '../src/steps.js';
import { terminalReporter } from '../src/terminal-reporter.js';
import { RUN_NEEDS } from './footprint.js';
import { leftoversStep, runEnv, runFolder, runFolderStep, runOf, TESTS_FOLDER, type LeftoversOptions, type WorldContext } from './world.js';

const reporter = terminalReporter({ write: (text: string) => process.stderr.write(text) });

export async function startWorld(options: LeftoversOptions): Promise<() => Promise<void>> {
  const outer = tmpdir();
  const run = await runOf(process.pid, join(outer, TESTS_FOLDER), THIS_CHECKOUT);
  const ctx: WorldContext = { commands: localCommands(process.env) };
  const steps: Step<WorldContext>[] = [runFolderStep(run), leftoversStep(run, options), await roomStep({ id: 'room', for: 'a test run', path: outer, needs: RUN_NEEDS })];
  await runSteps(steps, ctx, reporter);
  const before = process.env.TMPDIR;
  process.env.TMPDIR = runFolder(run);
  process.env[DOWNLOADS_VARIABLE] ??= outer;
  Object.assign(process.env, runEnv(run));
  return async () => {
    if (before === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = before;
    await removeSteps(steps, ctx, reporter);
  };
}

export default function setup(): Promise<() => Promise<void>> {
  return startWorld({ containers: true });
}

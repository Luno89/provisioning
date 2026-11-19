import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { localCommands, roomStep, runSteps, StepFailed, terminalReporter } from '@koala/provision';
import { RUN_NEEDS } from '../../packages/provision/testing/footprint.js';

const HERE = fileURLToPath(import.meta.url);

export async function roomForRuns(runs: number): Promise<void> {
  const step = await roomStep({ id: 'room', for: runs === 1 ? 'a test run' : `${runs} test runs side by side`, path: tmpdir(), needs: RUN_NEEDS * runs });
  await runSteps([step], { commands: localCommands(process.env) }, terminalReporter({ write: (text: string) => process.stdout.write(text) }));
}

export function refuseWithoutRoom(cwd: string, runs = 1): void {
  const checked = spawnSync('npx', ['tsx', HERE, String(runs)], { cwd, stdio: 'inherit' });
  if (checked.status !== 0) throw new Error(`there is not room for ${runs === 1 ? 'a test run' : `${runs} test runs`} where tests write; it is said above`);
}

if (process.argv[1] === HERE) {
  roomForRuns(Number(process.argv[2] ?? '1')).catch((err: unknown) => {
    if (!(err instanceof StepFailed)) process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}

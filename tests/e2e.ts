import { resolve } from 'node:path';
import { E2E_STEPS } from './lib/gates.js';
import { devStackProblem, git, minutesSince, runSteps } from './lib/gate-runs.js';
import { e2eEnv } from './lib/e2e-env.js';

const REPO = resolve(new URL('.', import.meta.url).pathname, '..');

async function main(): Promise<void> {
  const admin = process.env.MECHANICS_ADMIN;
  if (!admin) throw new Error('set MECHANICS_ADMIN to the admin whose invites, model and agents the suites use');
  const stack = await devStackProblem(REPO);
  if (stack) throw new Error(stack);
  const commit = git(REPO, ['rev-parse', 'HEAD']);
  const started = Date.now();
  const steps = runSteps(REPO, commit, E2E_STEPS, e2eEnv(admin));
  console.log(`\n✓ the e2e tier: ${steps.length} suites in ${minutesSince(started)} min against the dev stack`);
}

main().catch((err: Error) => {
  console.error(`\n✗ e2e: ${err.message}`);
  process.exit(1);
});

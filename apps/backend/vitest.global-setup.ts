import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';
import { removeSteps, runSteps, terminalReporter, type ServiceContext } from '@koala/provision';
import { memoryMongo } from './src/platform/testing/memory-mongo.js';
import { mongoStep } from './src/platform/wiring/root-services.js';

declare module 'vitest' {
  export interface ProvidedContext {
    mongoUri: string;
  }
}

const reporter = terminalReporter({ write: (text: string) => process.stderr.write(text) });

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const mongo = memoryMongo(join(tmpdir(), 'mongo'));
  const steps = [mongoStep(mongo, () => mongo.address())];
  const ctx: ServiceContext = {};
  await runSteps(steps, ctx, reporter);
  mongo.onEnded((why) => {
    process.stderr.write(`\n${why}\nThe run ends here, since every test after this would wait on it; the next run removes what this one leaves.\n`);
    process.exit(1);
  });
  project.provide('mongoUri', mongo.uri());
  return () => removeSteps(steps, ctx, reporter);
}

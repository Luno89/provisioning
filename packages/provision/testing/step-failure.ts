import { StepFailed } from '../src/steps.js';

export async function stepFailureOf(run: Promise<void>): Promise<StepFailed> {
  const err: unknown = await run.then(() => undefined, (thrown: unknown) => thrown);
  if (!(err instanceof StepFailed)) throw new Error(`expected the run to fail with StepFailed, it ended with ${String(err)}`);
  return err;
}

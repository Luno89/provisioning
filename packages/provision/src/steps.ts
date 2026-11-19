import { tail } from './tail.js';

export type StepState = { done: true } | { done: false; why: string };

export interface Progress {
  line(text: string): void;
}

export interface Step<Context> {
  id: string;
  title: string;
  check(ctx: Context): Promise<StepState>;
  apply(ctx: Context, progress: Progress): Promise<void>;
  remove?(ctx: Context, progress: Progress): Promise<void>;
}

export interface StepName {
  id: string;
  title: string;
}

export interface Reporter {
  started(step: StepName): void | Promise<void>;
  alreadyDone(step: StepName): void | Promise<void>;
  line(step: StepName, text: string): void;
  done(step: StepName): void | Promise<void>;
  failed(step: StepName, failure: StepFailed): void | Promise<void>;
}

export const TAIL_LINES = 40;

export class StepFailed extends Error {
  constructor(readonly stepId: string, readonly title: string, readonly why: string, readonly tail: readonly string[], options?: ErrorOptions) {
    super(`${title} (${stepId}): ${why}`, options);
    this.name = 'StepFailed';
  }
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function telling<Context>(step: Step<Context>, reporter: Reporter): { name: StepName; progress: Progress; failure: (why: string, cause?: unknown) => Promise<StepFailed> } {
  const name: StepName = { id: step.id, title: step.title };
  const printed = tail(TAIL_LINES);
  const progress: Progress = {
    line(text) {
      printed.add(text);
      reporter.line(name, text);
    },
  };
  const failure = async (why: string, cause?: unknown): Promise<StepFailed> => {
    const failed = new StepFailed(step.id, step.title, why, printed.lines(), cause === undefined ? undefined : { cause });
    await reporter.failed(name, failed);
    return failed;
  };
  return { name, progress, failure };
}

async function runStep<Context>(step: Step<Context>, ctx: Context, reporter: Reporter): Promise<void> {
  const { name, progress, failure } = telling(step, reporter);
  const fail = async (why: string, cause?: unknown): Promise<never> => {
    throw await failure(why, cause);
  };
  const checked = async (asked: string): Promise<StepState> => {
    try {
      return await step.check(ctx);
    } catch (err) {
      return fail(`${asked}: ${messageOf(err)}`, err);
    }
  };

  await reporter.started(name);
  if ((await checked('its check failed before applying')).done) {
    await reporter.alreadyDone(name);
    return;
  }
  try {
    await step.apply(ctx, progress);
  } catch (err) {
    await fail(messageOf(err), err);
  }
  const after = await checked('its check failed after applying');
  if (!after.done) await fail(after.why);
  await reporter.done(name);
}

export async function runSteps<Context>(steps: readonly Step<Context>[], ctx: Context, reporter: Reporter): Promise<void> {
  for (const step of steps) await runStep(step, ctx, reporter);
}

export async function removeSteps<Context>(steps: readonly Step<Context>[], ctx: Context, reporter: Reporter): Promise<void> {
  let first: StepFailed | undefined;
  for (const step of [...steps].reverse()) {
    if (!step.remove) continue;
    const { name, progress, failure } = telling(step, reporter);
    await reporter.started(name);
    try {
      await step.remove(ctx, progress);
      await reporter.done(name);
    } catch (err) {
      const failed = await failure(`removing it failed: ${messageOf(err)}`, err);
      first ??= failed;
    }
  }
  if (first) throw first;
}

import { failureOf, stillDown } from '@koala/engine-core/failures';
import type { Progress, Step, StepState } from './steps.js';
import { Hopeless, waitUntil, type WaitOptions } from './wait-until.js';

export interface ServiceContext {
  wait?: WaitOptions;
}

export interface Provider<Context> {
  running(ctx: Context): Promise<StepState>;
  start(ctx: Context, progress: Progress, unanswered?: string): Promise<void>;
  ended(ctx: Context, progress: Progress): Promise<string | undefined>;
  remove?(ctx: Context, progress: Progress): Promise<void>;
}

export interface Service<Context> {
  id: string;
  title: string;
  provider: Provider<Context>;
  answers: () => Promise<StepState>;
}

const NOT_ANSWERING = 'it does not answer: ';

async function answered<Context>(service: Service<Context>): Promise<StepState> {
  try {
    return await service.answers();
  } catch (err) {
    const failure = failureOf(err);
    if (failure.kind === 'final') throw new Hopeless(failure.reason, { cause: err });
    return { done: false, why: `${NOT_ANSWERING}${failure.reason}` };
  }
}

async function stateOf<Context>(ctx: Context, service: Service<Context>): Promise<StepState> {
  const running = await service.provider.running(ctx);
  return running.done ? answered(service) : running;
}

export function serviceStep<Context extends ServiceContext>(service: Service<Context>): Step<Context> {
  const { provider } = service;
  const step: Step<Context> = {
    id: service.id,
    title: service.title,
    check: (ctx) => stateOf(ctx, service),
    async apply(ctx, progress) {
      const running = await provider.running(ctx);
      const answer = running.done ? await answered(service) : undefined;
      await provider.start(ctx, progress, answer && !answer.done ? answer.why.replace(NOT_ANSWERING, '') : undefined);
      await waitUntil(
        `${service.title} to answer`,
        async () => {
          const state = await stateOf(ctx, service);
          if (!state.done) throw stillDown(state.why);
          return true;
        },
        () => provider.ended(ctx, progress),
        ctx.wait,
      );
    },
  };
  const remove = provider.remove?.bind(provider);
  return remove ? { ...step, remove } : step;
}

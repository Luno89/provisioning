import { ApplicationFailure, TemporalFailure } from '@temporalio/common';
import { failureOf } from './failures.js';
import { heartbeatWhileRunning } from './liveness.js';
import { traceActivities } from './telemetry.js';
import { carryWorkFor } from './work-for.js';

export { WAITING_RETRY } from './failures.js';

interface Execute {
  execute<I>(input: I, next: (input: I) => Promise<unknown>): Promise<unknown>;
}

export function classified(err: unknown): unknown {
  if (err instanceof TemporalFailure) return err;
  const failure = failureOf(err);
  const error = err instanceof Error ? err : undefined;
  return ApplicationFailure.create({
    message: error?.message ?? String(err),
    type: error?.name ?? typeof err,
    nonRetryable: failure.kind === 'final',
    ...(error ? { cause: error } : {}),
  });
}

export function classifiedFailures() {
  return (): { inbound: Execute } => ({
    inbound: {
      async execute(input, next) {
        try {
          return await next(input);
        } catch (err) {
          throw classified(err);
        }
      },
    },
  });
}

export const activityInterceptors = () => [heartbeatWhileRunning(), traceActivities(), carryWorkFor(), classifiedFailures()];

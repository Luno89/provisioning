import { waitUntil, type WaitOptions } from '@koala/provision';

export interface SetupWaitsDeps {
  job(name: string): Promise<unknown>;
  mongo(): Promise<void>;
  wait?: WaitOptions | undefined;
}

interface JobLike {
  status?: { succeeded?: number; conditions?: Array<{ type?: string; status?: string; reason?: string; message?: string }> };
}

const failure = (job: JobLike) => job.status?.conditions?.find((condition) => condition.type === 'Failed' && condition.status === 'True');

export async function setupWaits(step: string, after: readonly string[], deps: SetupWaitsDeps): Promise<void> {
  await waitUntil(`the instance's Mongo to answer before ${step}`, async () => {
    await deps.mongo();
    return true;
  }, undefined, deps.wait);
  for (const name of after) {
    let last: JobLike | undefined;
    await waitUntil(
      `${name} to finish before ${step}`,
      async () => {
        last = await deps.job(name) as JobLike;
        return (last.status?.succeeded ?? 0) > 0 ? true : undefined;
      },
      async () => {
        const failed = last ? failure(last) : undefined;
        return failed ? `${name} failed, so ${step} cannot run after it: ${failed.message ?? failed.reason ?? 'its pod ended in failure'}` : undefined;
      },
      deps.wait,
    );
  }
}

import { failureOf, statusFailure } from '@koala/engine-core/failures';
import { boundedWhy, JOIN_PROGRESS_PATH, joinProgressCredential, type JoinProgress, type JoinProgressState } from '@koala/engine-core/machine-join';
import { Hopeless, waitUntil, type Reporter, type StepName, type WaitOptions } from '@koala/provision';

export interface JoinProgressSink {
  tell(progress: JoinProgress): Promise<void>;
}

const reasonOf = (err: unknown): string => {
  const message = err instanceof Error ? err.message : String(err);
  return err instanceof Error && err.cause instanceof Error ? `${message} (${err.cause.message})` : message;
};

export function rootJoinProgress(rootUrl: string, code: string, fetcher: typeof fetch, wait: WaitOptions = {}): JoinProgressSink {
  const url = `${rootUrl.replace(/\/+$/, '')}${JOIN_PROGRESS_PATH}`;
  const post = async (progress: JoinProgress): Promise<true> => {
    let response: Response;
    try {
      response = await fetcher(url, { method: 'POST', headers: { 'content-type': 'application/json', ...joinProgressCredential(code) }, body: JSON.stringify(progress) });
    } catch (err) {
      const failure = failureOf(err);
      if (failure.kind === 'final') throw new Hopeless(`root could not be told this machine's progress: ${reasonOf(err)}`, { cause: err });
      throw new Error(`root could not be reached: ${reasonOf(err)}`, { cause: err });
    }
    if (response.ok) return true;
    const said = (await response.text()).trim();
    if (statusFailure(response.status).kind === 'final') {
      throw new Hopeless(`root did not take this machine's progress (${response.status}): ${said}`);
    }
    throw new Error(`root answered ${response.status}: ${said}`);
  };
  return {
    tell: async (progress) => {
      await waitUntil(`root to hear that ${progress.stage} ${progress.state}`, () => post(progress), undefined, wait);
    },
  };
}

export function rootReporter(sink: JoinProgressSink): Reporter {
  const tell = (step: StepName, state: JoinProgressState, why?: string) => sink.tell({ stage: step.id, title: step.title, state, ...(why !== undefined ? { why } : {}) });
  return {
    started: (step) => tell(step, 'started'),
    alreadyDone: (step) => tell(step, 'already-done'),
    line: () => undefined,
    done: (step) => tell(step, 'done'),
    failed: (step, failure) => tell(step, 'failed', boundedWhy(failure.why)),
  };
}

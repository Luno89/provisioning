import { failureOf, statusFailure } from '@koala/engine-core/failures';
import { boundedLine, boundedWhy, progressCredential, type MachineProgress, type ProgressState } from '@koala/engine-core/machine-progress';
import { Hopeless, waitUntil, type Reporter, type StepName, type WaitOptions } from '@koala/provision';

export interface ProgressSink {
  tell(progress: MachineProgress): Promise<void>;
}

export const reasonOf = (err: unknown): string => {
  const message = err instanceof Error ? err.message : String(err);
  return err instanceof Error && err.cause instanceof Error ? `${message} (${err.cause.message})` : message;
};

export interface RootAsking {
  unreachable: string;
  refused: string;
}

export async function askRoot(fetcher: typeof fetch, url: string, init: RequestInit, asking: RootAsking): Promise<Response> {
  let response: Response;
  try {
    response = await fetcher(url, init);
  } catch (err) {
    const failure = failureOf(err);
    if (failure.kind === 'final') throw new Hopeless(`root ${asking.unreachable}: ${reasonOf(err)}`, { cause: err });
    throw new Error(`root could not be reached: ${reasonOf(err)}`, { cause: err });
  }
  if (response.ok) return response;
  const said = (await response.text()).trim();
  if (statusFailure(response.status).kind === 'final') throw new Hopeless(`root ${asking.refused} (${response.status}): ${said}`);
  throw new Error(`root answered ${response.status}: ${said}`);
}

const TELLING: RootAsking = { unreachable: 'could not be told this machine\'s progress', refused: 'did not take this machine\'s progress' };

export function rootProgress(url: string, credential: string | (() => Promise<string>), fetcher: typeof fetch, wait: WaitOptions = {}): ProgressSink {
  const post = async (progress: MachineProgress): Promise<true> => {
    await askRoot(fetcher, url, { method: 'POST', headers: { 'content-type': 'application/json', ...progressCredential(typeof credential === 'string' ? credential : await credential()) }, body: JSON.stringify(progress) }, TELLING);
    return true;
  };
  return {
    tell: async (progress) => {
      await waitUntil(`root to hear that ${progress.stage} ${progress.state}`, () => post(progress), undefined, wait);
    },
  };
}

export const rootUrlOf = (rootUrl: string, path: string): string => `${rootUrl.replace(/\/+$/, '')}${path}`;

export interface RootReporting {
  lines?: boolean;
  ending?: { stage: string; url: string };
}

export function rootReporter(sink: ProgressSink, reporting: RootReporting = {}): Reporter {
  let told = Promise.resolve();
  let lineLost: { err: unknown } | undefined;
  const tell = (step: StepName, state: ProgressState, extra: Partial<MachineProgress> = {}) => sink.tell({ stage: step.id, title: step.title, state, ...extra });
  const ended = (step: StepName): Partial<MachineProgress> => (reporting.ending?.stage === step.id ? { url: reporting.ending.url } : {});
  const inTurn = (telling: () => Promise<void>): Promise<void> => {
    const next = told.then(() => {
      if (lineLost) throw lineLost.err;
      return telling();
    });
    told = next.catch((err: unknown) => { lineLost ??= { err }; });
    return next;
  };
  return {
    started: (step) => inTurn(() => tell(step, 'started')),
    alreadyDone: (step) => inTurn(() => tell(step, 'already-done', ended(step))),
    line: (step, text) => {
      if (!reporting.lines || text.trim() === '') return;
      inTurn(() => tell(step, 'started', { line: boundedLine(text) })).catch((err: unknown) => { lineLost ??= { err }; });
    },
    done: (step) => inTurn(() => tell(step, 'done', ended(step))),
    failed: (step, failure) => inTurn(() => tell(step, 'failed', { why: boundedWhy(failure.why) })),
  };
}

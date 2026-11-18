import type { Reporter } from './steps.js';

export function allReporters(...reporters: Reporter[]): Reporter {
  const each = async (tell: (reporter: Reporter) => void | Promise<void>): Promise<void> => {
    for (const reporter of reporters) await tell(reporter);
  };
  return {
    started: (step) => each((reporter) => reporter.started(step)),
    alreadyDone: (step) => each((reporter) => reporter.alreadyDone(step)),
    line: (step, text) => { for (const reporter of reporters) reporter.line(step, text); },
    done: (step) => each((reporter) => reporter.done(step)),
    failed: (step, failure) => each((reporter) => reporter.failed(step, failure)),
  };
}

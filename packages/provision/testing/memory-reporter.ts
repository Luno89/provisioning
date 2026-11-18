import type { Reporter, StepFailed, StepName } from '../src/steps.js';

export type Reported =
  | { kind: 'started' | 'already-done' | 'done'; id: string }
  | { kind: 'line'; id: string; text: string }
  | { kind: 'failed'; id: string; why: string; tail: readonly string[] };

export interface MemoryReporter extends Reporter {
  readonly reported: Reported[];
  linesOf(id: string): string[];
}

export function memoryReporter(): MemoryReporter {
  const reported: Reported[] = [];
  return {
    reported,
    started: (step: StepName) => { reported.push({ kind: 'started', id: step.id }); },
    alreadyDone: (step: StepName) => { reported.push({ kind: 'already-done', id: step.id }); },
    line: (step: StepName, text: string) => { reported.push({ kind: 'line', id: step.id, text }); },
    done: (step: StepName) => { reported.push({ kind: 'done', id: step.id }); },
    failed: (step: StepName, failure: StepFailed) => { reported.push({ kind: 'failed', id: step.id, why: failure.why, tail: failure.tail }); },
    linesOf: (id: string) => reported.flatMap((entry) => (entry.kind === 'line' && entry.id === id ? [entry.text] : [])),
  };
}

/**
 * A Temporal failure wraps the complaint rather than being it: `handle.result()` rejects with
 * "Workflow execution failed", whose cause is an activity failure, whose cause is the thing that
 * actually went wrong — "The workspace image did not build: No match for argument: jq-nonexistent".
 *
 * A run that died should say why on the tree it ran on. Without this the person gets the status word
 * ("failed") in the UI, `{"name":"ImageBuildError"}` in the worker's log, and a kaniko log to dig
 * through for the one line that names the mistake.
 */

/** Failures that say a wrapper failed, not what failed inside it. */
const WRAPPER = /^(workflow execution (failed|terminated|timed out|canceled)|activity task failed|nested activity failed)/i;

/** How far down a cause chain to walk before deciding it is a cycle or a rabbit hole. */
const DEPTH = 8;

export function failureReason(status: string, err: unknown): string {
  const said: string[] = [];

  for (let walk: unknown = err; walk && said.length < DEPTH; walk = (walk as { cause?: unknown }).cause) {
    const message = (walk as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) said.push(message.trim());
  }

  // The outermost message is usually the wrapper; the first specific one is the reason.
  const specific = said.find((message) => !WRAPPER.test(message));
  return specific ?? said.at(-1) ?? status.toLowerCase().replace(/_/g, ' ');
}

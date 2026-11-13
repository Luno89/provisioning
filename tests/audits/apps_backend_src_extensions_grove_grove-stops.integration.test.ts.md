# Audit: grove-stops.integration.test.ts, "stopping the run stops the leaf mid-task" (2026-11-13)

## What failed
Hung to its 120 s limit in ship's coverage gather (2026-11-13 02:16, and twice before, on 2026-11-12, which `3c64ff705` noted). The
first case of the file never hung. Teardown then printed "Channel has been shut down" from the client's retry, a consequence: the
test's `handle.result()` was still waiting when the connection closed.

Reproduced with twelve copies of the file run at once under the gather's settings (`COUPLING_COVERAGE`, `TEMPORAL_DEBUG=1`, half the
cores): 9 hangs in 48 runs of the file, always the second case, none of the first.

## The cause
Not Koala's code. Since `303660e02` (owner, 2026-11-12) the file ran on Temporal's in-memory test server (the Java test server), and
that server refuses a workflow task that Temporal itself takes, then never hands the workflow a task again.

Every hang matched exactly one line from the worker, "Error while completing workflow activation: ACTIVITY_UNKNOWN for
scheduledEventId=…", and no run that passed had one. The history of the stuck run, read from the test server: the grove run had
signalled both leaves to stop, and the second leaf's executor, the one not hanging on purpose, ended with an `EngineNodeActivity`
scheduled, the stop signal, then `WorkflowTaskScheduled` and `WorkflowTaskStarted` and nothing more; the server listed no pending
activity and no pending task. The stop reached that executor while one of its quick steps was finishing: the task that handled the
signal cancelled the step's scope (`cancellable` in `AgentRunWorkflow`, `TRY_CANCEL`), and by the time it answered, the step had
already finished on the server. Temporal takes a cancel for an activity that is no longer running as a no-op. The test server
answers FAILED_PRECONDITION and forgets the task: it never times it out and hands it out again, as Temporal does after the task's
ten seconds, so the executor, its leaf and the grove run wait forever. It is the same flaw the 2026-11-02 audit of grove-run found
(a task started and never handed out again); this is one way to trigger it.

It needs the stop to arrive while some run under the grove is between quick steps, which load makes likely and an idle machine rare.
The same file on the real Temporal server (`realTemporalEnvironment`), as it ran before `303660e02`: 84 runs of the file under the
same load, alone, under the gather's settings and inside a full backend integration run, no hang and no ACTIVITY_UNKNOWN.

## How it is now built
- grove-stops runs on the real Temporal server, a namespace of its own, as production runs it. The rule `303660e02` set (files that
  list workflows, describe task queues, boot processes or depend on real time use the real server) now has one more reason: a file
  that stops a run while other runs under it are still working, since stopping cancels steps that may finish at the same moment.
- Nothing in the workflow changed: a stop cancelling a step that has just finished is correct, and Temporal takes it.

## Found, not fixed
- `AgentRunWorkflow.integration.test.ts` ("cancelling a run stops the model call in flight in its delegated child") stops a run on the
  test server too (`clockSkippingEnvironment`, which its timer cases need). There the only step running at the stop is the one that
  hangs on purpose, so the race is far narrower, and it has not hung; the same refusal could still meet it.
- The contract suite (`temporal-contract.integration.test.ts`) does not hold the test server to this: cancelling an activity that
  finished while the cancelling task ran. A case that hits the race on demand needs the activity to finish inside the window between
  the task starting and answering, which could not be made reliable here.

## Proof
Twelve copies of the file at once under the gather's settings, five rounds: 60 runs of the file, 120 tests, no hang, no
ACTIVITY_UNKNOWN (2026-11-13).

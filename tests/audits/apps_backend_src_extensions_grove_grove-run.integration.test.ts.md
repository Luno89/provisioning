# Audit: grove-run.integration.test.ts, "stopping the run stops the leaf mid-task" (2026-11-02)

## What failed
Hung to its 120 s limit: once in ship's gather (2026-11-02 morning, before any change that day), then in full integration runs,
and about once in four to ten runs of the file alone. It passed with logging around the run, which looked like timing.

## The cause
Not Koala's code. The file ran on Temporal's time-skipping test server (the Java test server, a stand-in for Temporal), and that
server lost a workflow task: probes of the hung run showed the leaf's executor (or its judge) with `WorkflowTaskScheduled` then
`WorkflowTaskStarted` by our worker as its last events, no pending activity, and the test process using no CPU. The worker never
held the task; a real Temporal server times such a task out after 10 s and hands it out again, and the test server never did. It hung
the same way with the old `ABANDON` path (1 in 10), so the day's stop changes were not the cause.

The leftover-workflow hypothesis was wrong: every workflow of the earlier tests had closed.

## How it is now built
- The grove tests run on the real Temporal dev server the integration tier shares (`temporalTestEnvironment`), as production runs
  them. They never needed time skipping: no workflow in them sleeps. Time skipping stays only where a durable timer must be skipped
  (the conversation countdown, the bench's idle timer, a trial's days, root's OVH waits, the removal grace).
- That exposed a real bug in the test: runs driven by the test were started by a `WorkflowClient` made without the file's
  namespace, so on the shared server they went to `default`, where no worker polled, and hung every time. The client is gone; runs
  start through `env.client.workflow`.
- The harness is `extensions/grove/testing/grove-world.ts` (`GroveWorld`: the world's records, `reset`, `run`); the tests are split by
  what they prove into `grove-run`, `grove-replan`, `grove-kinds` and `grove-stops`, which run in parallel (108 s together; one file on
  the real server took 320 s, since a workflow task there takes about 26 ms against 3 ms on the test server).
- A test that waits for a step no longer polls a counter every 100 ms: the scripted model resolves `firstCall(kind)` when it is first
  asked for that kind of step.

## Found on the way (fixed)
- Run activities used `ABANDON`, so stops reached them only through a 3 s query poll; now `TRY_CANCEL` behind `nodes-hear-stops`,
  delivered on heartbeats within `STOPS_ARRIVE_WITHIN_MS` (2 s, `WORKER_DEFAULTS` on every worker, production and tests).
- A step started after its run was stopped (the run's own ending) was never told: with the poll gone nothing aborted it. The workflow
  now sends `stoppedBecause` with such a step, whose signal is aborted from the start (`activities.test.ts`).
- Each integration file started its own Temporal dev server; now one per run, a namespace claimed per file. The setup's own
  registration of `KoalaOwner` on each namespace was redundant (the server registers it on every namespace it is started with).

## Proof
The four files passed five runs in a row, and in two full integration runs (2026-11-02). The one other failure in those runs, a 5 s
timeout in `instance-trial.integration.test.ts`, belongs to the owed audit of the tier's timeouts under memory pressure.

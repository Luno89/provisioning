# Audit: worker-cluster.integration.test.ts (2026-11-22)

## What failed
The file never ended on main (2026-11-21, seen by deletion agent 5 and the coordinator); it was stopped by hand each time. It
passes on today's main only because 7eb41cbfa made the workflows bundle again; the fault under the hang was still there.

## The cause
1. **A worker that can never be made was read as Temporal being down** (code): the cluster and host workers start through
   `backendWorkerOnceTemporalAnswers`, which tried again, for ever, on any failure. When `08a22f0fc` put a Node import into code
   `AgentRunWorkflow` bundles, `Worker.create` failed to bundle on every try, so the worker said "Connection to Temporal server
   failed", marked Temporal down, and waited 5 s, 10 s … 60 s between tries that could never succeed. The process never stopped
   and never said why, a quiet degrade (an error read as "not running").
2. **The test waited on a poller and nothing else** (test): it looped until Temporal listed the worker's poller, without looking at
   the worker's own run, so a worker that failed or stopped left the loop waiting on a thing that could never come.

## The fix
- `onceTemporalAnswers` tries again only on a failure the one rule (`failureOf`) calls temporary; a final one stops the start with
  "<worker> cannot start: <why>" at once, and Temporal is not said to be down (`worker-interceptors.test.ts`, watched failing first:
  the old loop started the worker on its second try).
- Every test that waits for a worker to poll does it through `untilPolling` with the run's `watchedRun`, which ends the wait with
  "nothing polls <queue>, and nothing will: the worker failed: <why>" the moment the run ends (cluster, host and engine workers,
  the device worker and its TLS test).

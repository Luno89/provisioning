# Audit: grove-run.integration.test.ts, "stopping the run stops the leaf mid-task" (in progress, 2026-11-02)

## What failed
Hung to its 120 s limit: once in ship's gather (2026-11-02 morning, before any change today), then repeatably in full integration
runs. It passes alone (`-t "stopping the run"`) every time, and fails only after the file's earlier tests ran.

## What is established
- The file runs every test on one time-skipping environment and the fixed stream queue `engine-stream-queue`.
- The stop test decides when to stop by counting model calls classified `exec-leafA` (`rounds`), shared by whatever stream task its
  worker takes.
- Logging around the run makes it pass (timing-dependent).

## Working hypothesis
A run left alive by an earlier test (the executor cancelled in "cancelling one leaf") still has stream work queued on
`engine-stream-queue`; the next test's stream worker takes it, it counts as `exec-leafA`, and the stop fires before the run under
test reached its leaf. Either a cancelled run does not end (a product bug), or the earlier test stops its workers before the stop
reaches the step (a test bug). Next: list the open workflows at the end of each test and see which.

## Found on the way (fixed)
- Run activities used `ABANDON`, so stops reached them only through a 3 s query poll; now `TRY_CANCEL` behind `nodes-hear-stops`,
  delivered on heartbeats within `STOPS_ARRIVE_WITHIN_MS` (2 s, `WORKER_DEFAULTS` on every worker, production and tests).
- Each integration file started its own Temporal dev server; now one per run, a namespace claimed per file.

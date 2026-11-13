# Audit: koala-telemetry.integration.test.ts (2026-11-13)

## What failed
Twice in full coupled gathers on the fence branch (2026-11-13), passing alone every time, with and without coverage.

- Round 2: the sign-up of the owner on root answered 401 in `beforeAll`. That run's output was not kept, so which request answered
  401 and why is not known; it has not happened since.
- The last round: "one trace … across both processes" found six spans whose parent was not among the spans read back:
  `POST /api/conversations`, `GET /api/checks/model-requests`, `POST /api/engine/runs` and three `GET /api/turns/:token`. Each is a
  request the check runner makes to the backend, and every other span of the trace was there.

## The cause
In the test. Those six requests are made from inside the check runner's activity on the engine worker, so their parent is that
activity's span. A span is exported when it ends, and the check runner's activity ends only when the whole check has finished
(after the model call, the turn's reading and the space's removal). The test waited until the spans it named were present and then
asserted that no span's parent was missing, at a moment the parent was still running and so could not have been sent. On a quiet
machine the engine worker's batch with the activity's span usually arrived before the backend's; under the load of the gather
(about 240 leftover processes were running then, since stopped) it did not.

## How it is now built
The test waits for the condition it needs: the spans it names, an activity of the engine worker, and every span's parent present,
which is the trace having arrived whole. There is no timer and no longer limit; a parent that never arrives fails at the test's
own limit with the trace's spans printed. It also asserts the link that made the trace cross processes: the parent of
`POST /api/engine/runs` is an activity on the engine worker.

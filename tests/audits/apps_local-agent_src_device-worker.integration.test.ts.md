# Audit: local-agent device-worker.integration.test.ts (2026-11-22)

## What failed
"connects with the machine's token, polls its own device queue…" expected 4 activity interceptors and got 5, twice (deletion agent
10's run and this one), since `d7dcbf82c` added `killOnCancel`. Not timing: the same every run.

## The cause
The test followed the interceptors by their count, so the one added on purpose broke it, and a count would equally have passed
with one interceptor swapped for another. The stream, cluster, host and engine workers' tests counted the same way (6).

## The fix
Each activity interceptor is a function named for what it does (`heartbeatsWhileRunning`, `tracesActivities`,
`carriesWhoseWorkItIs`, `killsProgramsOnCancel`, `classifiesFailures`, `refusesDeletingWork`). Every worker test asserts the list
by name (`interceptorsOf`, against `EVERY_ACTIVITY` or `REFUSING_DELETING_WORK` in engine-core's Temporal test helpers), so the
next one added or removed names itself in the failure. Watched failing first: the names were all empty.

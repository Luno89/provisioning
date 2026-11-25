# Audit: infrastructure/wiring/provisioning.integration.test.ts (2026-11-25)

## What failed
Ship's gather of every layer (`test:integration:coupled`) hung twice on this file:
- 07:45 PST, on ac6b89cd5: quiet 13 minutes;
- 08:47 PST, on d2595725f: quiet 20 minutes.

Both times its vitest worker had no child processes, the test Mongo was healthy and the Temporal dev server was up. `npm run
test:status` called the file "starting", which hid where it was. Run alone, with or without coverage, it passed 6 of 6 in about
35 s, and it passed in the gather on f3206f63f earlier the same day.

## Reproduced
The backend workspace was run as the gather runs it (`tests/coupling/gather.ts --only backend`, coverage on, half the cores as
workers). The file stuck again four minutes in. Read through the worker's inspector, the worker was in the test "starts the setup
the cluster worker asks for on another machine by opening its record, and the cluster worker hears how it ended", not starting.
- In the test Mongo, the lab's setup record was `running` and already held `workflowId: provision-machine-lab-…`.
- In the test Temporal, that workflow was still running: the test had not reached the signal that ends it.
So the test was waiting for the record to name its workflow, and the record already did.

## The cause (test)
The test waited for the record by hand, opening a change-stream watch and reading the record at the same moment, without waiting
for the watch to be open. When the write naming the workflow landed after the read but before the change stream was open, which a
loaded run makes likely, neither saw it, and the wait could never end. `setUpBeforeTheEngineConnects` had the same race: it
started the setup without waiting for its watch to open, and read nothing at all.

The services do this in the right order (`settledRun`: watch, wait until it is open, then read). The test re-declared the wait
instead of keeping that order.

## The fix
One `recordWhen` in the test keeps the services' order: it opens the watch, waits until it is open, then acts and reads. Both waits
use it.
- The wait for a workflow's name also ends when the record settles without one, and the assertion then says so.
- The setup's wait ends with the reason when starting the setup fails.

## Found on the way (not fixed here)
`npm run test:status` showed "starting" for a file deep in its fourth test. Its reporter sets "starting" when it hears the file
start, and drops the worker's own "beforeAll" or test-name notices that arrive earlier than that, so a file can stay "starting"
for its whole run.

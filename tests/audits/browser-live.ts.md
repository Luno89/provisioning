# Audit: browser-live.ts (2026-11-24)

## What failed
Twice, both times in ship, both times before a browser opened:
- 2026-11-09 20:18Z: this commit's app image was built without `vendor/`, so the split stack's containers could not start
  (recorded in `ee097eb3f`, fixed that day).
- 2026-11-24 12:47Z: the first step, making the run's own Temporal namespace, ran
  `docker exec provisioning-temporal-1 temporal operator namespace create …` and Docker answered
  `exec: "temporal": executable file not found in $PATH` (exit 127).

## What I found
On 2026-11-19 `2197aeaa9` moved Temporal from `temporalio/auto-setup`, which carried the `temporal` CLI, to `temporalio/server`
1.32.2, which carries only `temporal-server` (checked: `/usr/local/bin` in the running container holds nothing else). That commit
ran the integration tier but no live suite, and `browser-live` last passed on 2026-11-17, so nothing ran the suites' Temporal
helper against the new image until today's ship. The helper exec'd the CLI inside whatever image the dev Temporal happened to be.

Three places did that: making and dropping a suite's namespace (`tests/lib/suite-root.ts`), and ending a workflow in the split
stack and in a person's own stack (`tests/lib/split-stack.ts`, `tests/lib/own-stack.ts`). A fourth, `tests/mesh-live.ts`, runs
`tctl` inside the instance's Temporal pod, which moved to the same server image; it is a release VM suite and is fixed with its
own run before the next release.

## The cause
Both failures are the same fault: the suite depended on what an image contains, and nothing held that dependency, so a change to
the image elsewhere broke the suite unseen until the daily run.

## The fix
The CLI now comes from the image that is pinned to carry it, Temporal's admin tools of the same release
(`temporalio/admin-tools:1.32.2`, CLI 1.10.0 for server 1.32.2), named from the pins file by version and digest
(`tests/lib/pinned-image.ts`), run in a throwaway container that shares the dev Temporal's network and is removed when it exits
(`Containers.runToEnd`). All three helpers go through one function, `temporalCli`. A Temporal upgrade now moves the CLI with it
through the pins file, and a pin that stops naming the image fails at once, saying so.

Watched failing first: the adapter's unit test for `runToEnd` and the pins reader's tests failed before the code existed. Proved
live: `temporal operator namespace list` from the admin tools image against the running dev Temporal lists `default` and
`temporal-system`. The suite's own run against the fresh stack ship left follows this commit, and its result is in the ledger.

## Also checked, nothing found
- The suite's other dependencies on the dev stack (its Mongo through the lease, the app image built from this commit, Mailpit and
  MinIO from pinned tags) do not depend on a tool inside another image.

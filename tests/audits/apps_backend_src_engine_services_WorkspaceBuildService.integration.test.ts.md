# WorkspaceBuildService.integration.test.ts failing twice

## What failed

- 2026-11-11 and 2026-11-21. On 2026-11-21 it failed before any test in it ran, beside release-runs.integration.test.ts: "Failed to start ephemeral server: failed to download ephemeral server executable … dns error".

## Why

- The file runs on the time-skipping Temporal test server (`clockSkippingEnvironment` → `timeSkippingTemporal`).
- `timeSkippingTemporal` called `TestWorkflowEnvironment.createTimeSkipping` with no executable, so the SDK fetched the test server itself, every run:
  - The version was whatever `https://temporal.download/temporal-test-server/default` named that day (v1.41.1 on 2026-11-21). Nothing in the pins file held it.
  - It went into the system temp folder, which the test world sets to the run's own folder. So every run downloaded it again, and a network failure became a test failure.
- The Temporal dev server the other tests use was already pinned (temporal-cli 1.10.1, cached in the shared test folder).

## Fix

- The test server is pinned in `dependencies.pins.json` (temporal-test-server 1.41.1).
- `timeSkippingTemporal` hands the SDK that version and the shared test folder, the way the dev server is set up. Runs share one download and never get another version.

## What is left

Both binaries are still fetched by the SDK the first time a run needs one, after a reboot or after the SDK's one-day cache runs out. No checksum is checked, so this is not yet "set up once from the pins". That needs a setup step that fetches each binary named in the pins file, checks its checksum, and hands the tests the path. It is a change to `npm run setup` and is reported, not built, here.

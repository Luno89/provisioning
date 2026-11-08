# Audit: instance-chart-stores.integration.test.ts, "comes up ready on the shared volume, answers the instance's own pods only…" (2026-11-08)

## What failed
Twice in full integration runs, neither a gate run: first the instance's own pod was refused by MinIO (2026-11-08 morning), then the
stranger's knock read as wget's "Connection refused" rather than the test's verdict `refused` (2026-11-08 evening). Both times the file
passed alone.

## The cause
The test's own reading of its pods, not the chart. Two separate faults:
- k3s's network policy controller adds a new pod's address to the policy's allowed set a moment after the pod starts, so an instance pod
  that knocks the instant it runs can be refused once. The product's own pods are long-running; this only bites a pod that knocks at once.
- The test read the last line of the pod's log, where wget's own error message (stderr) and the test's `echo` (stdout) are mixed, and
  their order is not fixed. So the verdict line was sometimes wget's message.

## How it is now built
- The instance's pod knocks until MinIO lets it in (`until wget …; do sleep 1; done; echo reached`): it waits for the condition it
  needs, the policy admitting it, rather than racing the controller.
- The stranger knocks once, and wget's own messages go to `/dev/null`, so the pod prints only `reached` or `refused`, and the stranger
  must be refused.

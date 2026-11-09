# Audit: app-sign-in-live.ts (2026-11-09)

## What failed
Both runs on 2026-11-09 (16:11 and 16:12 UTC) stopped before any app was deployed:
- the first asserted that `MECHANICS_ADMIN` (or `GROVE_LIVE_OWNER`) names an admin, and nothing set it;
- the second, given an address for it, could not read its settings: `databaseSettingsFrom` refused, `MONGO_URI is not set`.

## The cause
Not Koala's code. The suite was still written for the combined dev stack, which went on 2026-11-08 (one kind of cluster, part 1):
it read `apps/backend/.env` for `MONGO_URI` and the keys, opened that database to mint an operator's session itself, called the
backend on `localhost:3001`, and deployed to the system cluster `provisioning-lunorica` through `/tmp/kubeconfig-provisioning-lunorica`
and `bin/kubectl`. None of those exist on the dev stack as it is now (root, the hub and an instance whose backend and workers run as
pods on this computer's k3s, reached on node port 30320). It was in no gate, so nothing ran it between the change and today.

## How it is now built
- It runs against the dev stack through `tests/lib/dev-stack.ts`, as every current live suite does: `devOwner()` signs dev's owner in
  at root and hands them to the instance, so the suite acts as a person would, through root's sign-in, and needs no setting.
- It deploys on the cluster of the machine Koala runs on, `machine-<INSTANCE_MACHINE_ID>`, read from the instance's own settings
  (`devKoalaEnv()`), the only cluster a dev instance has.
- `kubectl` and the port-forward go through `devKubectl` and `devPortForward` on that k3s.
- It passed on 2026-11-09 in about 2 minutes (the deploy, Show sign-in, the Deployment's secretKeyRef, the dashboard's sign-in and
  refusals, the destroy) and is in ship's live steps, so it can no longer rot unseen.

## Found on the way
- CLAUDE.md listed `test:app-names-live`, a suite that no longer exists; the line is gone and the note that relied on it says so.
- `test:hub-live` and `test:project-sharing-live` are still written for the combined dev stack, as CLAUDE.md says; they are in no gate.

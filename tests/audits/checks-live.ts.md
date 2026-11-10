# Audit: checks-live.ts (2026-11-09)

## What failed
In ship on 2026-11-09, four mechanics checks failed: `mechanics-odoo-module`, `mechanics-monitoring` and
`mechanics-odoo-browser-failure` with "the world's app could not be deployed: Cluster not found", `mechanics-member-asks` with the
hub answering 500 when the check's project was shared, and `mechanics-run-revoked` with "signing the space out everywhere was
refused: 404". Two more runs of only the first three, while their cause was being found, failed the same way.

## The cause
Not flakiness: step 3 B (one kind of cluster, the combined role gone, 2026-11-08) was not carried into the check runner.
- A check's space is a hidden account of its own. Its world's app went on the cluster Koala runs in, which was the shared system
  cluster; since step 3 B that cluster is the owner's machine, and a cluster is its owner's alone, so the space got the 404 anyone
  else gets. Three faults stood between the space and its person's cluster:
  1. the permissions table had no rule for a space acting for its person;
  2. on an instance the engine worker signs a space in with its claims inside the session, and the check those claims pass when they
     are read back (`claimsShaped`) knew only the older kinds of claim;
  3. the check runner handed the sign-in only the space's id and email (`deps.api({ id, email })`), so `claimsOf` never saw whose
     space it was. This was found by reading the records (the cluster's owner, the instance owner and the space's person are the same
     account) after the first two fixes alone did not change the answer.
- `mechanics-member-asks` shares its project with dev's hub, which cannot mint a Gitea token: the instance chart's setup job made
  Gitea's admin password in its own data folder, and dev's hub reads the one this computer had before.
- `mechanics-run-revoked` signs its space out everywhere, which since step 3 only root does, and a check's space has no account at
  root; revocation reaches an instance only as root's signed back-channel logout.

## How it is now built
- A check's space holds a `space-of` claim naming its person and none of the install's; the cluster rows let it see and deploy to
  its person's clusters only, never change or remove one, nor reach anyone else's (`platform/lib/permissions.ts`, tested).
- `claimsShaped` takes that claim; the check runner signs a space, and a shared project's member space, in with whose space it is.
- The three checks then passed live on the dev stack (2026-11-09), their spaces leaving nothing behind.
- `mechanics-member-asks` and `mechanics-run-revoked` are left out of ship by name, each with its reason, in
  `NOT_ON_AN_INSTANCE` (`tests/lib/e2e-env.ts`, tested), on the owner's word ("if its slow and isn't telling us anything then either
  way"); the plan's deferred list says how each comes back.

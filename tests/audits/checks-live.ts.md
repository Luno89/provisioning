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

# Audit: checks-live.ts (2026-11-24)

## What failed
The day's runs (one recorded in the ledger at 21:08Z; the earlier ones were stopped by hand once they hung, and recorded nothing)
showed four faults, each a real bug in the code, each found by a check that had passed on 2026-11-17:
- mechanics-tree-model failed, and mechanics-project-deletion, -item-chats and -story-drop hung for good.
- mechanics-item-chats hung again, alone, once the first fault was fixed.
- mechanics-odoo-module and mechanics-odoo-browser-failure failed every run.

## What I found
- Deleting a project whose trees had workspaces never ended. Its workspace step counted every workspace the trees could have,
  which `kubectl delete --ignore-not-found` "deleted" again on every pass, and the sweep, which ends only on a pass that removed
  nothing, ran 4260 passes until Temporal ended it at its 51200-event history limit (four deletions, read from Temporal). The
  tests' fake cluster said yes to everything and held the wrong count (`1771f98e7`).
- A leaf getting its workspace when its run was stopped never stopped: the stop killed each kubectl the pod wait started, and the
  wait read every killed read as "no pod yet" and asked again for good, so the deletion waiting on the leaf never ended. Traced on
  the dev stack by tracing each step of the leaf's claim and moving a pause until the deletion landed inside it (`bc72e38bb`).
- The Odoo 20 image now carries PostgreSQL 19's client tools beside an older server. Both Odoo scripts took the newest
  `/usr/lib/postgresql/*/bin`, which has no initdb, so Odoo's database never started; that exit, 127, was read as "this image has
  no koala-e2e", and the person was told to add a dependency they had (`d9f70b4e4`).

## The cause
None of these is a race in the suite: each is the code assuming something of a program outside it (what kubectl does with a name
that is gone, what a killed kubectl returns, what an image installs, what 127 means), with nothing holding that assumption.

## The fix
- The deletion removes and counts only the workspaces that are there, asking the cluster first (checked against real kubectl).
- The pod wait goes on only while the cluster does not answer for now, by the one rule for kubectl failures; a pod that is gone or
  a killed read ends it with why.
- One shared step picks the newest PostgreSQL with its server and refuses with why when there is none; a browser test run checks
  for its runner and says it is missing by an exit code of its own.
Each watched failing first; each failing check passed alone on the dev stack after its fix.

# Audit: checks-live.ts again (2026-11-25)

## What failed
Ship on 963610ec0, the mechanics checks: 23 of 24 passed, and `mechanics-odoo-module` failed with "the world's app books did not
deploy". The cluster worker's log says why, which the check did not: Terraform's `Failed to create Ingress 'books-8dff3c/app'
because: namespaces "books-8dff3c" not found`. The suite then ended with `TypeError: fetch failed` (ECONNREFUSED) in
`where-it-failed.ts` instead of its report. Its failure on 2026-11-24 was the same suite failing in ship.

## The cause
- **The Ingress could be made before its namespace (code).** Every app stack made its namespace as a resource, then handed the
  Ingress and the blackbox probe the namespace's name as a plain string. Terraform saw no link between them and made them in
  parallel; whenever the Ingress won, the cluster refused it. 26 constructs and the spec app shared the one mistake through
  `createAppIngress` and `createAppProbe`, so any app could fail its deploy by chance.
- **The check dropped the deploy's reason.** The deployment recorded why it failed; the check said only "did not deploy".
- **The report of where it failed crashed on a port-forward still opening (code).** `devPortForward` returns as kubectl starts,
  before it listens. The first `fetch` to Tempo was refused, and undici reports that as a `TypeError`, which the one wait read as
  a mistake in the test and threw, rather than as a connection not open yet.

## The fix
- `createAppIngress` and `createAppProbe` take the namespace resource itself and name it by its reference, so Terraform makes the
  namespace first in every app (proven by synthesizing every app: each Ingress and probe names `kubernetes_namespace.….name`).
- A check whose world app fails says the deployment's own reason, or that the deployment gives none.
- The wait asks the one rule (`failureOf`) before calling a `TypeError` a mistake: a network failure is waited through, and the
  port-forward's exit still ends it.
Each watched failing first.

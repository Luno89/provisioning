# Audit: OdooReleaseService.integration.test.ts, "carries what the app was last given into a vault that lost it" (2026-11-05)

## What failed
The vault was seeded with nothing (`POSTGRES_PASSWORD` and `ODOO_ADMIN_PASSWORD` undefined), twice, each time in a full
integration run on a loaded machine; it passed alone and in the run after.

## The cause
In Koala's code. `OdooReleaseService` starts a follow of a project's release run with every release (`void this.follow(...)`),
and nothing ever ended one: `stop()` closed the change stream and left every follow running. A follow outlives the call that
started it by design, since a release run lasts as long as it lasts, but a service that cannot be stopped keeps writing. Each
test made its own service on the one database the file shares, emptied before each test; the previous test's follow saw its run
end and marked its release failed in the next test's freshly emptied database. That test then found a release already there, so
`named` took the project as released before and named it the old way (`shop`) instead of `newReleaseName` (`shop-<hash>`), and
asked the cluster for the vault in a namespace that never held it. The generation counter in the test's run double had been
holding the leak back without stopping it.

## How it is built now
The service owns an ending (an `AbortController`): `stop()` ends it, closes the stream and waits for every follow to return; a
follow checks it before each step, its wait for a run to close and its wait after a lost connection race it, and `follow` after
`stop` starts nothing. Both test files stop every service they make after each test. "stops following its runs when it is
stopped, and writes nothing about them afterwards" proves it, and fails on the code before.

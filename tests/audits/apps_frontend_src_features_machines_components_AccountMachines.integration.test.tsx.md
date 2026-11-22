# Audit: frontend machines/components/AccountMachines.integration.test.tsx (2026-11-22)

## What failed
"shows a machine joining with the command made elsewhere…" hung in a run of `src/features/machines` beside the unit tier
(2026-11-22T07:14:37Z), and again in three parallel runs of that folder (07:31Z); each was stopped by pid. Alone it passes in 3.3 s.
Reproduced on purpose afterwards: six parallel runs hung two to three of six.

## The cause (code)
My Machines lost a change it heard while its first load was still on its way. The panel's "Add a machine" button shows before
the list arrives, so the case reported the join step while the panel's first `GET /my-machines` was in flight. Traced with the
requests the backend answered: that request read the machines before the step was written, root's `machine-joins-changed` reached
the page before the answer did, and the page's invalidation of a query that has no data yet joins the fetch already running
(TanStack Query cancels an in-flight fetch for a refetch only once the query holds data). The answer from before the change
became the page, nothing read again, and the step was never shown. A person opening My Machines while a machine reports sees a
stale list until the next change. The same model was in every socket-driven invalidation: machines, the Koala install, Koala's
setup, the grove, deployments, releases, a destroyed resource, and the reconnect that invalidates everything.

## The cause (test)
`shown` waited on a MutationObserver with no end but the text appearing, so a text that could never come hung the run instead
of failing it; a `find` that threw inside the observer also left it waiting forever.

## The fix
- `heardChange(client, filters)` (platform lib) cancels what is in flight for those queries and then invalidates them, so a load
  that began before the change is replaced by one after it. Every socket-driven invalidation and the reconnect use it. Unit case
  "reads again when the change comes while the first load is still on its way…" watched failing against plain invalidation.
- `shown(find, { client })` ends with why when what it waits for can never be shown: a query or change of the page's client
  fails, the page's socket closes or is not connected, or `find` throws. AccountMachines' waits pass the panel's client.
- Watched after: two rounds of six parallel runs of `src/features/machines`, every run passed.
- Not changed yet: the other five files that call `shown` without a page (signed-out, ProvisioningCard, RootAdmin,
  deleted-elsewhere, RootLayout) can still hang on a text that never comes; they are next.

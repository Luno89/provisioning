# Audit: machines/wiring/sides.integration.test.ts (2026-11-21, second)

## What failed
"root tells the owner's connected machines again each time the instance reports…" hung over 7 minutes in a run of 15 backend
integration files together (killed by pid, twice recorded), and passed alone in 305 ms.

## The cause (test)
The case connected the machine without waiting for root to admit it, started the instance's presence connection straight after,
and then waited for exactly two tells. Root tells a machine where its Koala is only over a connection it already holds: when the
instance arrived before root had admitted the machine (its handshake checks a key token in Mongo, slow under a full run), that
tell went to nobody, the machine heard only its connect tell, and `told.length === 2` could never become true. The case beside
it waited for the first tell before starting the instance, which is why it never hung. Watched: starting the instance first and
the machine after it, the old case hung past three minutes (baseline 50 s for the file) and was stopped by pid.

A second way to hang was in every exact-count wait polled every 20 ms: two tells landing between polls skip the count and the
wait never ends.

## The fix
- `hearing(socket, event)` in `machines/testing/wiring-world.ts` keeps what a socket hears and `saidTimes(n)` ends the moment the
  n-th arrives, or fails the moment the connection closes or is refused, saying how many of n came. No polling.
- The machine's world waits for its connect tell (root admitted it) before the instance connects, so the arrival tell has a
  connection to reach. Each wait then asserts the whole list heard, so an extra tell fails the case rather than hanging it.
- The browser cases and machine-tokens' "hands the machine its Koala…" moved to the same helper; agent-updates' "ended" wait
  waits for at least two and then asserts the list.
- Found after, in the sibling root-link world (recorded once, 2026-11-22): "tells root its mesh address…" waited for "more koalas
  than before" while the agent's own renewal ask (its work token is already due, root's clock being behind) could land in place
  of the tell it meant, and then counted one koala too many. It now waits for the connect and the renewal first, both named.
- Not changed: `InstancePresence.integration` (instances area) counts what its own fakes record with `===`; each count there is
  of calls the case itself causes one at a time, so none can be skipped.

# Audit: machines/wiring/sides.integration.test.ts (2026-11-21)

## What failed
The new case "root's removal of the owner reaches their Koala over its presence connection…" failed twice before it was first
committed, each time for its own cause. Neither was timing, and neither was rerun for green.

## The causes, each fixed
1. **Two checks started the Koala's removal at once** (code): the Koala checks whether root removes its owner when root tells it
   and when its presence connection opens. Both saw no removal and both started `DeleteAccountWorkflow`; the second got
   "Workflow execution already started" and the check failed, so a person's removal logged a failure that was not one.
   `OwnerRemoval.check` now reads a start another check made first as running (unit case "reads a removal that another check
   started a moment before as running").
2. **The case asserted an order the design does not promise** (test): it expected root's first activity before anything of the
   Koala's, but root tells the Koala the moment its removal workflow starts, so the Koala's first step may come first. The case
   now asserts only what the decision says: root's machines, mesh and records come after the Koala deleted its owner's records.

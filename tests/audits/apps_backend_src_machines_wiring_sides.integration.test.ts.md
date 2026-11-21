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

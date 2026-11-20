# Archive ledger

What was taken out of Koala and where to find it again. Git keeps the code: `git show <commit>^:<path>` brings a removed
file back as it was the moment before it went.

## The pool and the move from it (tabled 2026-11-20)

Owner, 2026-11-20: "lets table the pool trial until the hosted version is out", then "go ahead an archive it too so that we
don't have the coverage baggage right now"; on the move to one's own machine: "Archive it with the pool (Recommended)"; on
root's page for someone with no Koala yet: "Straight to adding a machine (Recommended)". The decision is `pool` in
`tests/alignment/decisions.ts`. The plans were `plans/archive/pool-instances.md` and `plans/archive/data-move.md`.

| Capability | What it did for a person | Served | Files | Removed in |
| --- | --- | --- | --- | --- |

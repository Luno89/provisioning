// A single source of truth for the built-in tool seeds lives in
// src/lib/engine-tool-seeds.ts (the production seeder, scripts/seed-all.ts,
// uses that one). This copy used to diverge — it silently lost the grove
// catalog (make_branch, make_leaf, ready_leaves, claim_leaf, settle_leaf),
// so any harness that pulled seeds from here offered a world without grove.
// 2026-07-22: kept as a forwarding shim so existing import paths keep
// working; the original body was byte-identical to the lib copy apart from
// the missing grove line.
export * from '../../lib/engine-tool-seeds.js';
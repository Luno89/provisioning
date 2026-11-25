# Audit: platform/testing/test-mongo.ts (2026-11-25)

## What failed
Ship's gather of every layer (`test:integration:coupled`) stalled twice in the backend's integration run, with no test file
finishing:
- 2026-11-24 21:19 on fa21c75df: 16 minutes stalled before it was stopped. The test Mongo was at 90% CPU with 106
  connections and 40,670 files in its dbpath. 30 operations had been running for 875 s without waiting on a lock:
  `deleteMany({})` on about 25 collections of one emptied-each-time database, and `createIndexes` in three. The rerun passed.
- 2026-11-25 03:27 on 513b74095: `notifications`, `change-streams`, `provider-sign-in` and `ConversationNoticeService` sat
  "starting" for 37 minutes. The test Mongo was at 85% CPU with 36,050 files in its dbpath.

## The cause (setup)
Every test file makes and drops its own databases. WiredTiger keeps the data handle of a dropped collection or index until it
has been idle for `close_idle_time`, 600 s by default. A full run drops collections far faster than that, so the handles
pile up: 32,000+ were open last night. Every later create, drop and `deleteMany` then sweeps that list, and the run grinds to a
halt. It is not any one test's fault: each file stays isolated, and the failure shows only in a full run, which makes it the
setup's (CLAUDE.md, Tests).

## The proof
A scratch run of the same churn (create, fill, drop collections in a loop) against mongod 8.0.38 with the test cache size, one
with the default engine and one with `file_manager=(close_idle_time=5,close_scan_interval=2)`:
- default: open data handles 10,885, then 10,882 twenty seconds after the churn stopped;
- with the setting: 10,161, then 4,938 twenty seconds later.

## The fix
The test Mongo starts with `--wiredTigerEngineConfigString file_manager=(close_idle_time=5,close_scan_interval=2)`
(`TEST_MONGO_ENGINE`), so the handles of dropped collections close within seconds instead of ten minutes. Production Mongo is
untouched: it does not churn databases. No test re-declares the setting. The full ship gather is its proof.

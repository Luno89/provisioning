# Audit: temporal-contract.integration.test.ts, "retries an activity that fails until it succeeds…" (2026-11-21)

## What failed
Failed on both servers (the in-memory test server and the real one), 2026-11-21 17:33 and 17:38, and again when this audit
reproduced it: the `retries` workflow failed with `RETRY_STATE_NON_RETRYABLE_FAILURE` on the first attempt of `flaky`, whose
failure was `new Error('not yet')`. Every run fails the same way; it is not a race.

## The cause
The test started running through Koala's own worker. Until `0da79b3c4` (every backend test's worker built by engine-core's
`createWorker`, 2026-11-19, merged into main on 2026-11-21) the file built a bare `Worker.create`
with no activity interceptors, so it held Temporal's own default: every activity failure is retried. Koala's workers classify every
activity failure with the one rule (`failureOf`, engine-core `failures.ts`) and make anything the rule does not call temporary
non-retryable. That is the design the owner kept on 2026-11-10 ("Keep them (Recommended)", asked: "Slice 3 makes temporary failures (a
dependency down) retry with no attempt cap, and anything else fail at once"), and CLAUDE.md's "One rule decides temporary or final".

So the code is right and the fixture modelled a failure Koala never retries: a plain `Error` is a fault in the code, not a dependency
that is down, and retrying it with no attempt cap would retry a bug for ever. What Koala relies on from Temporal is that a failure the
rule calls temporary is retried until it succeeds, and a final one stops at once.

Making a plain `Error` temporary was considered and refused: it would reverse the owner's 2026-11-10 answer and, with no attempt cap,
turn every bug in an activity into a step retried for ever.

## How it is now built
- `flaky` fails the way a dependency that is down fails (a connection reset, `ECONNRESET`), which the rule calls temporary; it is
  retried until it succeeds, as before.
- A new activity, `breaks`, throws a plain `Error`: the workflow sees it fail at once, and it ran exactly once. The case now holds
  both halves of the rule on both servers.

## Found, not fixed
- Nothing else in the file ran on a bare worker; every other case already went through `createWorker` and passed.

## Proof
The file on both servers, 14 tests, all passing (2026-11-21).

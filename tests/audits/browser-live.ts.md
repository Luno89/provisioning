# Audit: browser-live.ts (2026-11-24)

## What failed
Twice, both times in ship, both times before a browser opened:
- 2026-11-09 20:18Z: this commit's app image was built without `vendor/`, so the split stack's containers could not start
  (recorded in `ee097eb3f`, fixed that day).
- 2026-11-24 12:47Z: the first step, making the run's own Temporal namespace, ran
  `docker exec provisioning-temporal-1 temporal operator namespace create …` and Docker answered
  `exec: "temporal": executable file not found in $PATH` (exit 127).

## What I found
On 2026-11-19 `2197aeaa9` moved Temporal from `temporalio/auto-setup`, which carried the `temporal` CLI, to `temporalio/server`
1.32.2, which carries only `temporal-server` (checked: `/usr/local/bin` in the running container holds nothing else). That commit
ran the integration tier but no live suite, and `browser-live` last passed on 2026-11-17, so nothing ran the suites' Temporal
helper against the new image until today's ship. The helper exec'd the CLI inside whatever image the dev Temporal happened to be.

Three places did that: making and dropping a suite's namespace (`tests/lib/suite-root.ts`), and ending a workflow in the split
stack and in a person's own stack (`tests/lib/split-stack.ts`, `tests/lib/own-stack.ts`). A fourth, `tests/mesh-live.ts`, runs
`tctl` inside the instance's Temporal pod, which moved to the same server image; it is a release VM suite and is fixed with its
own run before the next release.

## The cause
Both failures are the same fault: the suite depended on what an image contains, and nothing held that dependency, so a change to
the image elsewhere broke the suite unseen until the daily run.

## The fix
The CLI now comes from the image that is pinned to carry it, Temporal's admin tools of the same release
(`temporalio/admin-tools:1.32.2`, CLI 1.10.0 for server 1.32.2), named from the pins file by version and digest
(`tests/lib/pinned-image.ts`), run in a throwaway container that shares the dev Temporal's network and is removed when it exits
(`Containers.runToEnd`). All three helpers go through one function, `temporalCli`. A Temporal upgrade now moves the CLI with it
through the pins file, and a pin that stops naming the image fails at once, saying so.

Watched failing first: the adapter's unit test for `runToEnd` and the pins reader's tests failed before the code existed. Proved
live: `temporal operator namespace list` from the admin tools image against the running dev Temporal lists `default` and
`temporal-system`. The suite's own run against the fresh stack ship left follows this commit, and its result is in the ledger.

## Also checked, nothing found
- The suite's other dependencies on the dev stack (its Mongo through the lease, the app image built from this commit, Mailpit and
  MinIO from pinned tags) do not depend on a tool inside another image.

# Audit: browser-live.ts, the two runs after (2026-11-24)

## What failed
With the namespace fixed, the suite went further each run and stopped twice more, both on what changed since it last passed on
2026-11-17:
- 16:24Z: the instance's sign-in callback said "this sign-in did not start in this browser". Root's own browser session moved to
  a server-held `koala_sid` cookie (`7ce0af9f3`), the name the instance's session has. The split stack served root and the
  instance both on `localhost`, apart only by port, and a browser keeps one set of cookies per host whatever the port, so signing
  in on root replaced the instance's session and the state its sign-in started with.
- 16:31Z: Infrastructure reported `409 GET /api/infrastructure/provisioning`. Since `902d0268a` (2026-11-18) a Koala with no
  cluster of its own answered the question "how far is setting up" with a refusal, and the page asks it every time.

## The cause
The first is the test world's: people's root and instance never share a host, and the split stack made them. The second is the
code's: a setting that is off with a reason is a state the person sees, and the route answered it as a failed request, which
the card then showed in red.

## The fix
- The split stack serves the instance on `127.0.0.1` and root on `localhost` (`splitPlace`, held by its unit test).
- The route answers `{ setups: [], can: [], off }` with the reason, the card shows the reason as a plain line, and asking to set
  up again is still refused with 409. Both watched failing first in the route's and the card's tests.

## Also checked, nothing found
- Root logs one `invalid_client … client not found` from the instance at its token endpoint during start; sign-in passes after
  it. It is a start-up order between the instance's processes and its registration at root, followed up on its own.

# Audit: browser-live.ts, logging out (2026-11-24)

## What failed
- 16:40Z: after Log Out the browser came back to the instance's chat, signed in, and the step's 30-second clock ran out.
- 17:50Z: the new wait for root's sign-out ended at once on what the page reported: `400 GET /socket.io/` and Chromium refusing
  an inline event handler under root's `script-src 'self'`.
(The run at 16:44Z, which hung on a wait with no end, was stopped by hand and recorded nothing.)

## What I found
Three faults in the code, one in the suite:
- The page sent the browser to root to end the sign-in, and in the same moment, now signed out, started a new sign-in (`8f3415a4e`
  shows it at unit: two navigations, root's sign-out and the instance's sign-in start, the second winning).
- Root's page for an instance's logout asked whether to end root's sign-in too and kept it unless the person said yes, so the
  new sign-in went straight through with no password. The owner, 2026-11-24: "if they log out the token should be expunged, theres
  no way they should get logged in again" (`9f0ead0f7`).
- Root's logout page submitted itself with an inline `onload`, which root's own policy forbids, so it never submitted: no logout,
  from an instance or from root's own pages, ever ended root's sign-in (`e2f8e9517`).
- The page's live connection kept reconnecting with the ended session (`e2f8e9517`).
- The suite waited on clocks, and once on nothing at all: the first never said why, the second hung.

## The cause
The logout flow had no test that followed it to its end in a browser; each piece was tested alone and the pieces disagreed.

## The fix
- The page holds at "Signing you out of Koala…", closes its connection, and goes only to root.
- Every logout ends root's sign-in at once through one page, submitted by a script root serves.
- The suite waits only through `seen` and `reached`: each ends on what it waits for, or at once on a failed request, a console
  error, a closed page, a stopped root or instance, or, for logging out, the instance signing the browser back in.

# Audit: browser-live.ts, logging out, the last two layers (2026-11-24)

## What failed
- Root's logout page now submitted, and the browser refused the redirect back to the instance: root's `form-action 'self'`
  governs where a submitted form may lead, and the instance is another origin.
- With that allowed, the suite's wait ended at once on "the browser is back on the instance, signed in again without a password".

## What I found
- Root's logout page carried root's whole policy, so its own redirect to the client's registered return address was blocked.
- Root holds two sign-ins in a browser: its provider's session and its own web session. Logging out ended the first only, and root
  finishes an instance's sign-in at once while its web session lives, so the instance's next sign-in went straight through.

## The fix
- Root's logout page lets its form lead on to exactly the return addresses the logging-out client registered (`formActionAlso`).
- Confirming a logout at root ends root's own web session in that browser before the provider ends its session.
Both watched failing first at unit.

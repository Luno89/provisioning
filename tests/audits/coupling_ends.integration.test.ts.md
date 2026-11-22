# ends.integration.test.ts failing twice

## What failed

- 2026-11-04, while the graph was being built out for the flow maps.
- 2026-11-22, on the first whole integration run on main since 11-20: "expected 349 to be greater than 350" HTTP edges. `frontend-routes.integration.test.ts` and `flows.integration.test.ts` failed with it, for the same cause.

## Why

Root's sign-in moved under `/oidc/interaction/:uid` (65c9d9941). Three things the graph reads stopped being readable, so three edges went missing:

- **The routes.** `interactionRouter` is made in the backend's bootstrap and handed through `wireInstances` and `oidcProviderRouter` as a `Router` value, because the instances area cannot import the accounts area by value without a cycle. The graph only followed a `use` whose router was a factory call, so it never saw these routes mounted.
- **The mount path.** Express writes a parameter in a mount path as `(?:\/([^/]+?))`. `routesOf` only knew an older form, so the routes Express printed were `/oidc/interaction(?:/([^/]+?))/login`. Nothing had mounted a router under a parameter before.
- **The calls.** The browser posted with `api` and a per-call `baseURL` override, to a path held in a plain `string`. The readers saw `/api:*/login`, which no route serves.

Nothing here is flaky: both runs failed on what the code was. The graph had blind spots, and the edge-count floor caught one.

## Fix

- The graph follows a mounted router through what it was handed: a variable, a conditional, a shorthand property, and a parameter's property back to each call that passed it, up to the factory that made it. Fixture: `fixture-http` mounts a router two hops away.
- `routesOf` reads Express's parameter form. `http-edges.test.ts` checks it against a real Express app.
- The browser has a second client, `site`, for paths beside the API, and the resume path is typed `InteractionPath` (`/oidc/interaction/${string}`). The readers read a parameter's literal or template literal type, so the call reads as `POST /oidc/interaction/:*/login`.
- The sign-in flow's entry is `signIn`, which `login` became. The flow also starts at root's client router, where the browser comes back from the provider and the session is held. The ending meets the flow again.

## What is left

The graph still cannot follow a browser redirect, so a flow that crosses one names both ends as entries. A router handed through something other than a property of a parameter (an array, a return value) is still not followed. Nothing mounts one that way today.

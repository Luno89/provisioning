# Audit: AppExposureService.integration.test.ts, "answers at <app>.localhost through the edge from the chart…" (2026-11-08)

## What failed
Twice in full integration runs (2026-11-07 and 2026-11-08, neither a gate run, so neither is in the ledger): the first request to
`shop.localhost:8000` after Expose locally answered 502 from the edge, with an empty body. The file passed alone and beside the
chart's MinIO test every time.

## The cause
The test's own setup, not Koala's code. The test makes a stand-in Traefik (a pod and a NodePort Service in namespace `traefik`) a
moment before it exposes the app, and the edge (Caddy in a container) reaches the app through the k3s node's address and that
NodePort. kube-proxy programs a new NodePort a little after the Service exists; under a full run's load that gap grew past the time
the test took to expose and ask, so Caddy's first connection was refused and it answered 502. In the product Traefik exists long
before anything is exposed, so the gap never meets a request.

The first fix (2026-11-07) waited for the Service's EndpointSlice to list the pod ready. That is the wrong condition: the slice is
written before kube-proxy has acted on it, which is why the test failed again.

## How it is now built
The setup waits for the condition the test depends on: the NodePort answering `from-the-app` when asked from inside the edge's own
container (`docker exec <edge> wget http://<node address>:<node port>/`), before the app is exposed. Nothing waits on a clock, and
the assertions after it are unchanged.

The same lesson is now written in CLAUDE.md's Test tiers for the shared k3s: a test claims only what it made, and waits on the
condition it needs rather than on something that usually precedes it.

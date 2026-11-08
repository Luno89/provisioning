# Audit: MoveExport.integration.test.ts, "pauses its self-upgrade, scales its apps to nothing remembering how many ran, and starts them again as they were" (2026-11-08)

## What failed
Twice in full integration runs (2026-11-07 and 2026-11-08, neither a gate run, so neither is in the ledger): `MoveExport.apps()`
threw `Unexpected end of JSON input` parsing the output of `kubectl get <COPIED_KINDS> -n <namespace> -o json --ignore-not-found`
(`MoveExport.ts`). The file passed alone every time.

## The cause
Two faults, one in the code and one in how the test placed itself.

In the code: `apps()` lists the namespaces first, then reads each one's objects with `--ignore-not-found`. kubectl, given that flag
and finding no object at all, prints nothing instead of an empty `List` (checked on the pinned k3s: an empty JSON `List` without the
flag, `""` with it). Every namespace that exists holds at least `kube-root-ca.crt` and the `default` service account, so the empty
answer meant the namespace was gone (or made a moment before and not yet filled), and the code then parsed `""`. The flag hid that
answer rather than stating it.

In the test: `MoveExport` moves every namespace on its cluster that is not the platform's (`isMovedNamespace`), because a pool
instance's cluster is its own vcluster. The test ran it on the k3s every integration file shares, so it also took other files'
namespaces, some of which those files deleted mid-read, and it scaled their Deployments and StatefulSets to zero while they ran.
CLAUDE.md's shared-k3s rule (a test works only in what it makes) cannot be met by a subject whose job is the whole cluster.

## How it is now built
`apps()` reads each namespace's objects without `--ignore-not-found`: kubectl always answers JSON (an empty list for an empty
namespace), and a namespace that disappears between the listing and the read fails at `get namespace` with kubectl's own NotFound,
naming it, rather than being parsed as nothing.

The test starts a k3s of its own (`startK3s`, removed after the file) instead of taking the shared one, as the pool instance has a
cluster of its own: everything `MoveExport` lists, scales and restores is what the test made. No namespace filter was added to
`MoveExport`, which would only exist for the test. The assertions are unchanged.

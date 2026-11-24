# Audit: local-agent agent-program.integration.test.ts (2026-11-23)

## What failed
Twice on 2026-11-21, at 17:40:14Z and 18:09:26Z, during the work that became `b1f46f574`, which recorded both failures by hand.
The ledger kept no failure text then. The file passed in both full runs on 2026-11-23, 5 lone runs here and 24 runs under load
(8 at once, three rounds).

## What I found
The first test ("reads its machine.json, connects to root…") started the agent's program with a throwaway `HOME` and `PATH`, but
without `KOALA_MACHINE_ROOT`. Every other test in the file goes through `program()`, which sets it. So the agent took `/` as its
machine (`apps/local-agent/src/index.ts:29`, `hostCluster(meshIp, { machineRoot: process.env.KOALA_MACHINE_ROOT || '/' })`) and
read the computer running the tests: `clusterState` (`apps/local-agent/src/machine-cluster.ts:171`) looks for
`/etc/koala/machine-k3s`, and on finding it runs `systemctl`. On its Koala connecting, the agent runs it from `startWork`'s connect
handler (`apps/local-agent/src/agent-work.ts:111`). This computer has that file whenever `npm run dev` has joined it (always during
ship, which builds a fresh dev stack), and does not after `npm run dev:reset`. So the test's result depended on the state of the
computer, not on the code.

With the file there and no `systemctl` on the test's `PATH`, the agent says
`whether this machine has its cluster could not be read: systemctl could not start: spawn systemctl ENOENT`. That line contains
`could not start`, which the test's wait reads as the engine worker failing to start (`expect(said).not.toContain('could not start')`).
I reproduced it here by taking out the `systemctl` stub: the test fails on that line every time while `/etc/koala/machine-k3s`
exists. `b1f46f574` added a `systemctl` stub that answers `inactive`. That turned the failure into a silent wrong reading: the agent
still read this computer's `/etc/koala/machine-k3s` and told its Koala the machine's cluster was `stopped`, which nothing asserted.

## The cause
The test's part of the world was not its own: one test read this computer's `/etc` through the agent's default machine root.

## The fix
The first test runs through `program()`, the same throwaway home and machine root as the rest of the file. Its own copy of the
spawn and the `systemctl` stub are gone. The test now also asserts what the agent tells its Koala about the machine it is on
(`machine:cluster`: `absent`, no GPUs), which is what My Machines shows. I watched it fail first: with the old setup it heard
`stopped`, read from this computer. With the fix it passes, with no `systemctl` stub, while this computer holds Koala's k3s.

## Also checked, nothing found
- The waits poll observed state every 100 ms (pollers on the device queue, sockets heard, the child's exit code), and each ends when
  the child exits. None waits on a clock.
- Ports are all ephemeral (`listen(0)`), and each file starts its own Temporal dev server and TLS front.
- Progress reports are awaited before each step applies (`packages/provision/src/steps.ts:71`), so the exact report lists in the
  install tests cannot race the chart fetch.
- On SIGTERM both the agent (`onStop`, then `exit(0)`) and Temporal's runtime (its default shutdown signals) act. The agent's exit
  wins, and the exit code was 0 in every run.

## What I could not prove
The two failures left no text, so I cannot show they were this line and not something in the uncommitted code of that morning.
What I can show: `b1f46f574`, the commit that recorded them, also added the `systemctl` stub to this one test and to no other, and
taking that stub out reproduces a failure every time on a computer that holds Koala's k3s.

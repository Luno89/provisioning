# Audit: koala-telemetry.integration.test.ts (2026-11-13)

## What failed
Three times in full coupled gathers on the fence branch (2026-11-13), passing alone every time, with and without coverage.

- Round 2: the owner's sign-up on root answered 401 in `beforeAll`.
- Round 4: "one trace … across both processes" found six spans whose parent was not among the spans read back:
  `POST /api/conversations`, `GET /api/checks/model-requests`, `POST /api/engine/runs` and three `GET /api/turns/:token`.
- Round 5: the owner's sign-up on root answered `Not found.` as plain text, which is not JSON and no Koala route's answer.

## The causes
Two, one in the shared test helpers and one in the test.

**Ports handed to a test's processes could belong to this computer's k3s.** `portToHandOn` (`packages/engine-core/testing/ports.ts`)
hands ports from 20000 to 32767, checking each by binding it. 30000–32767 is Kubernetes' NodePort range, and this computer's k3s, like
every machine Koala installs k3s on, answers its NodePorts on 127.0.0.1 (`nodeport-addresses`) through kube-proxy's rules, with no
socket listening. So the probe binds such a port, finds it free, and root binds it too, but every connection to `localhost:<port>` is
taken by kube-proxy to the Service. Checked on this machine: nothing listens on 31737, and `POST localhost:31737/api/auth/register`
answers `Not found.` from the dev Gitea; 30320 (the dev instance) answers 401, as does 30354 (an app). The readiness check is fooled the
same way, since the Service answers it. Round 5's `Not found.` is Gitea's; round 2's 401 fits the instance's or the app's. Whether a
gather hit it depended on which port the process's pid led to.

**The trace was judged before it could be whole.** Round 4's six requests are made from inside the check runner's activity on the
engine worker, so their parent is that activity's span. A span is sent when it ends, and that activity ends only when the whole check
has finished. The test waited for the spans it named and then asserted that no parent was missing, while the parent was still running.

## How it is now built
Ports are handed from 20000 to 29999, below the NodePort range and below the range the system picks outgoing ports from;
`ports.integration.test.ts` holds it there.

The test waits for the condition it needs: the spans it names, an activity of the engine worker, and every span's parent present,
which is the trace having arrived whole. There is no timer and no longer limit; a parent that never arrives fails at the test's own
limit with the trace's spans printed. It also asserts the link that makes the trace cross processes: the parent of
`POST /api/engine/runs` is an activity on the engine worker.

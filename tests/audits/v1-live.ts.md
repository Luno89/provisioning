# Audit: v1-live.ts (2026-11-14)

## What failed
v1-live, the v1 story end to end on the dev stack and this computer's 3090s, failed every run from 2026-11-13 until it first
passed on 2026-11-14 (62726b50d). Each run failed at a different, later step, and each failure had its own cause in the code or in
the suite. None was timing.

## The causes, each fixed
1. **The signed-out page**: the socket opened before anyone signed in and answered 400, and the signed-out `/api/auth/me` 401 was
   counted as a page error. The socket is made with `autoConnect: false` and connected once someone is signed in (6cb3b2227);
   the browser suites share one page watcher that expects only that 401 (980d8db73).
2. **My Machines' GPU line read after leaving the page** (a suite bug, 43068724c).
3. **The suite deleted the owner's project channel** (2026-11-13): `/#/chat` reopened the owner's latest chat, the suite chatted
   there and deleted every conversation it chatted in, and it retired the memories of every `memory-*` run since it began. The
   channel was restored from Mongo's oplog with the owner's yes. Now every suite on the dev instance records only what it made
   (`tests/lib/made-here.ts`): v1-live opens a New chat of its own, takes its id from the response that made it, removes only that,
   forgets only its own runs and its chat's keeper runs, and ends by checking the owner's conversations and default model are as
   they were (dc4c0e86d, 84f686009). gpu-live, app-sign-in-live, odoo-release-live and checks-live got the same guard.
4. **The NVIDIA device plugin crash-looped under CDI alone** ("Driver Not Loaded"), so the node advertised no GPU, and readying
   said ready because the old plugin still advertised them. The plugin runs under k3s's nvidia runtime while apps' pods get GPUs
   by CDI, the join installs the full toolkit, and readying waits for the applied plugin's own rollout (7a6f732c5).
5. **An unhandled wait crashed the run past its clean-up**, leaving its vLLM deployed and the owner's default on it: a
   `waitForResponse` started before a click that never sent its request rejected while nothing awaited it. Each click is now awaited
   together with the response it causes (84f686009); the owner's default and deployments were put back by hand.
6. **vLLM v0.32.0 refused every Koala chat turn**: `"auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser`.
   vLLM was deployed without tool calling by default. Tool calling is now on by default with the parser chosen from the model's
   family, and a model served without it cannot be made the default and is refused before a turn reaches it (23d41b936).
7. **The model's window could not hold Koala's chat opening**: at 4096 and then 16384 tokens vLLM refused the prompt itself. The
   model call now leads with the window, what the turn needs and the fix (fa1ad9fcc); the suite serves Qwen2.5-0.5B-Instruct's full 32768. That Koala's opening is over 16k tokens is
   open for the owner (`~/.claude/plans/decisions-2026-11-14-open.md`).

## On the first fresh dev stack (2026-11-15)
The first runs after `dev:reset`, as a new owner on a new root, failed three times, each on something a stranger's first Koala
would hit:
8. **This computer showed offline on My Machines, its agent never told where its Koala was.** The install finished while root
   restarted under its watcher, and the machine told root `ready` once, with no second try, so root kept the instance installing
   until a self-upgrade check-in reported it ready. That check-in, in turn, changed the status without telling the person's
   machines, who were told only when an instance connects to root. The machine now tells root each state until root hears it,
   waiting out a lost connection or a 5xx on the layer's backoff (0706d8b6c), and root tells the owner's machines whenever a
   report changes the instance's status (cbe2ab1d0).
9. **A fresh owner is asked for a first model**, and that dialog, whose rows name the machine, covered My Machines; the suite's
   card locator matched it. The suite now sees the dialog and puts it off, as a person deploying their first model does (056a3e471).
10. **Every vLLM app showed "Down: it does not answer" while it answered.** Its probe asked `/`, where vLLM serves nothing, and the
    fresh stack's Prometheus read the probe (the old stack's never had, so the page showed the record's state). The probe asks
    `/health`, as its readiness does (056a3e471). TabbyAPI's has asked `/health` since 6802236e6.

## On the second and third fresh dev stacks (2026-11-16)
11. **My Machines showed this computer twice, once offline.** The first `npm run dev` after a reset stopped at the join's first
    sudo prompt, which came minutes after it started and timed out unanswered. Root had already made the machine when the join
    traded its code, and `machine.json`, which running the command again reads to replace that machine, was written only at the
    end, so the second run added a machine beside the ghost. The suite took the first card by name. The join now keeps
    `machine.json` as soon as root answers, so a join stopped at any later step is replaced, never doubled; dev counts this
    computer joined only once the agent's service is installed, and asks for sudo at its start, before anything else, keeping it
    until the join ends (61147cfab).
12. **The owner's default named a model that was gone.** Koala makes someone's first running model their default; destroying it
    (or aborting it, removing its machine, clearing its cluster) deleted the record and left the default naming nothing, so the
    first-model dialog never came back and a chat would fail with "Model not found". gpu-live, run before it, left the dev stack
    so. Every way a deployment's record goes now forgets it as anyone's default (owner, 2026-11-16: "Clear it"), and gpu-live
    checks the default is as it found it. A run after that one failed in its clean-up with "socket hang up": I saved a backend
    file while it ran and the dev backend reloaded under it, which is no fault of the code.

## How it is now built
Each failure pointed at something a person would hit (a page error, a GPU not offered, a model that cannot chat, an obscure 400),
and each fix is in the product with its own unit and integration tests; the suite changes are the guard, the awaited clicks and the
context it serves. It runs on the disposable dev stack as a fresh owner (owner, 2026-11-14: "Disposable, reset each run"), and passed
there on 2026-11-15.

## Since 2026-11-16: three more failures, one cause in the code
1. **2026-11-16 22:24**: after the vLLM half destroyed its app, the app's dashboard stayed open over the page, so TabbyAPI's
   "Deploy an app" could not be clicked. The cause was in the product: a finished destroy never told the browser. Only the
   removed abort sent `resource-destroyed`, so the page's own handler (close that app's log, clear its destroying state, say it
   is gone) never ran on an ordinary destroy. The suite closed the dashboard by hand then (c2ce58db4), which hid it.
2. **2026-11-17 18:13**: the deliberate fault check of the build Koala pins (the wizard's TabbyAPI default put back to `latest`);
   v1-live failed saying "TabbyAPI runs ghcr.io/theroyallab/tabbyapi:latest, not the build Koala pins", as meant. No fault.
3. **2026-11-17 23:18**: the product fix for 1 landed (a2cfc171e: the destroy's end tells its owner's browsers), and the page
   closed the dashboard itself before the suite's hand-close, which then found no button.

**How it is now built**: the destroy workflow's end sends `resource-destroyed` to the owner's browsers (TemporalBridge's settle,
tested in TemporalBridge.test.ts), and v1-live checks the destroyed app's dashboard closes by itself rather than closing it.

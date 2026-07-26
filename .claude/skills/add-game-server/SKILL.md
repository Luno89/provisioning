---
name: add-game-server
description: Add a new game-server app type (Minecraft, Valheim, Satisfactory, …) to this platform. Use when adding, wiring, or debugging a UDP/TCP game server as a deployable app — covers the settings schema, the CDKTF construct, hostPort/UDP exposure, the health probe, secrets, and the enumeration lists that must all be updated together.
---

# Adding a game server

Palworld (`lib/palworld-settings.ts`, `constructs/palworld.ts`) is the reference implementation —
read it alongside this. The reusable foundation already exists; you are filling in per-game pieces,
not building infrastructure.

## Why game servers are different

Every other app here is HTTP: it gets a Kubernetes Ingress, an `http_2xx` blackbox probe, and is
exposed through Traefik + localtunnel. A game server has none of that. It speaks UDP on a port
players type by hand, so the Ingress/Traefik/exposure path does not apply at all.

## The recipe

### 1. Settings schema — `apps/backend/src/lib/<game>-settings.ts`

Export an `AppSettingsSchema` (see `lib/app-settings-schema.ts`). One entry per container env var.
Source of truth is the container image's own entrypoint/config-generation script — read it, don't
guess env var names.

- Mark ports and `PUID`/`PGID` `readonly: true`. The construct owns them; a user editing the game
  port leaves the hostPort, Service and cloud firewall pointing at the old number and silently
  breaks connectivity.
- Mark passwords `secret: true`. They are stripped from the stored map and injected from a
  Kubernetes Secret instead (step 5).
- Floats: write defaults in the game's own format (`1.000000`, not `1`). The validator preserves
  the string you write so the UI's modified-vs-default comparison stays correct.

Register it in `APP_SETTINGS_SCHEMAS` in `apps/backend/src/index.ts`.

Write the schema test first — copy `lib/palworld-settings.test.ts`. `validateSchemaShape()` catches
duplicate env names, bad categories, and defaults that fail their own validation.

### 2. Thread the app type through

- `lib/types.ts` — add to the `appType` union
- `services/StorageAdapter.ts` — add a `case` returning the volume names, or the PVC size is
  silently unconfigurable (this is why `openwebui` and `gitapp` can't be resized today)
- `packages/cdktf-infra/main.ts` — read the new `STORAGE_*` var (the list is hardcoded) and add the
  dispatch branch in the **native** strategy block

`appSettings` itself is already threaded end to end — you do not touch the eight enumeration lists.

### 3. The construct — `packages/cdktf-infra/constructs/<game>.ts`

Use `lib/game-server-ports.ts` for ports and the Service. Non-negotiables:

- **`strategy: { type: "Recreate" }`.** `SyncConfigActivity` does an unconditional
  `kubectl rollout restart` on every config save. With `hostPort` (one pod can bind the port) and an
  RWO PVC, the default RollingUpdate **deadlocks permanently** — new pod Pending forever, old pod
  never terminated. This is the single most likely way to brick a game server.
- **`terminationGracePeriodSeconds`** long enough for the game's shutdown save. The 30s default
  truncates world saves on servers that flush on SIGTERM.
- **`securityContext`** `runAsUser`/`runAsGroup`/`fsGroup` matching PUID/PGID so the PVC is writable.
- **`startupProbe`** with a long window (`tcpSocket`, high `failureThreshold`) — first boot usually
  downloads several GB via SteamCMD. Model it on `constructs/vllm.ts`'s model-load probe.
- **Settings injection: inline `env` list, sorted by key.** Not `envFrom` + ConfigMap: a ConfigMap
  change does not alter the pod template, so `cdktf deploy` would report "no changes".
- **Skip `createAppIngress`.** Call `createAppProbe` with `module: "tcp_connect"` against a TCP
  control/API port — the game's UDP socket usually binds before the world finishes loading, so it is
  a worse liveness signal than the control port.

### 4. Reachability

Player-facing ports need `exposeOnHost: true` (hostPort). Whether that is enough depends on the
cluster's runtime, and the two differ in a way the kubeconfig context name actively hides:

- **Native k3s** (the always-on management cluster on Linux — systemd unit
  `k3s-provisioning-lunorica.service`, containerd on the host, node named after the machine):
  `hostPort` binds straight onto the host's network stack, so the port is reachable at the
  machine's IP immediately. Nothing else may already hold that port, and only one instance of a
  given game can run per node.
- **k3d** (nested containerd in a container): the port is *not* published to the host unless the
  cluster was created with an explicit `-p` mapping, which `ensure-cluster.sh` does not do. Expect
  "deploys fine, unreachable" there.

> Do not infer the runtime from the kubeconfig context. The management cluster's context is named
> `k3d-provisioning-lunorica` for legacy reasons even when it is native k3s, and
> `systemctl is-active k3s` reports `inactive` because the unit carries the cluster name. Check
> `ps aux | grep '[k]3s server'` or the node's `containerRuntimeVersion` instead.

On a cloud VM you additionally need a firewall rule. For Hetzner that means adding the ports to
`constructs/hetzner-vm.ts` — the firewall is created during **cluster** provisioning, long before
any app deploy, so the rule is unconditional.

### 5. Secrets — `DeployAppActivity`

Generate passwords with `crypto.randomBytes` **inside the activity** and create the Secret with
`kubectl` *after* `infra.deploy()` (the namespace doesn't exist before then). Model on the existing
`gitapp` / `gitea-registry` block.

Values must originate in the activity and must not be returned in the result: anything passed as an
activity argument or returned from a workflow lands in Temporal history permanently, and anything in
`buildAppEnv` lands in synthesized Terraform on disk.

Also in `DeployAppActivity`: a node-memory preflight (`kubectl get nodes -o json`, compare
allocatable against the game's minimum) before deploying. Without it an undersized node leaves the
pod Pending for the full 80-minute activity timeout with no useful error.

### 6. Frontend

`apps/frontend/src/App.tsx`: `APP_DEFAULTS` entry (`hasDatabase: false`, `strategies: ['native']`),
both `appType` unions, the `<select>` option, the wizard-reset object, the duplicated
`getSupportedVolumes`, and a branch in the submit ternary forcing `strategy: 'native'`.

> Forgetting `strategy: 'native'` silently deploys **Odoo** — `main.ts` defaults strategy to `'helm'`
> and the helm branch falls through to Odoo with no error.

Config tab: reuse the generic schema-driven editor rather than writing a per-game panel. Warn before
saving — every save restarts the server and disconnects players.

## Verify

`cdktf synth` assertions are the highest-value check and need no cluster or credentials. Assert on
the generated `cdk.tf.json`: `host_port` + `protocol: "UDP"` present, `strategy.type == "Recreate"`,
the grace period, zero `kubernetes_ingress_v1` resources, the probe's `module`, and — grep the whole
file for a sentinel password — **zero hits**, which mechanically proves secrets never reach disk.

Then on a real cluster: `kubectl exec … cat <the generated config file>` and diff it against the
settings you sent. That is the actual end-to-end proof the env-var → config mapping is right.

## Known platform-wide caveats

- `tcp_connect` requires the `ObservabilityStack` to be re-applied on any pre-existing cluster, or
  the probe reports down forever and fires `AppProbeDown`.
- The probe will alert during first boot while the game downloads. Same as vLLM's model load —
  consistent, not new.
- `hostPort` means one instance of a given game per node.

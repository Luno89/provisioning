import { Construct } from "constructs";
import { Namespace } from "../.gen/providers/kubernetes/namespace/index.js";
import { Deployment } from "../.gen/providers/kubernetes/deployment/index.js";
import { PersistentVolumeClaim } from "../.gen/providers/kubernetes/persistent-volume-claim/index.js";
import { createAppProbe } from "../lib/app-probe.js";
import { buildGameContainerPorts, createGameServerService, type GamePort } from "../lib/game-server-ports.js";

/**
 * Palworld dedicated server — the platform's first game server.
 *
 * Deliberately does NOT call createAppIngress: this is a UDP game server with no HTTP surface
 * worth routing. Players connect straight to the node on the game port via hostPort (see
 * lib/game-server-ports.ts for why hostPort rather than NodePort or LoadBalancer). The
 * consequence is that AppExposureService — Traefik + localtunnel, entirely HTTP — has nothing
 * meaningful to do for this app type, so the UI must not offer to expose it.
 *
 * The ~120 PalWorldSettings.ini options arrive pre-resolved as one map (APP_SETTINGS_JSON, built
 * from lib/palworld-settings.ts on the backend) rather than as individual construct props.
 */

/** Container image's own ports. Only the player-facing two get a hostPort. */
const GAME_PORT = 8211;
const QUERY_PORT = 27015;
const REST_PORT = 8212;
const RCON_PORT = 25575;

/**
 * Injected from the `palworld-secrets` Secret, which DeployAppActivity creates after the apply.
 * Keep in sync with PALWORLD_SECRET_ENVS in apps/backend/src/lib/palworld-settings.ts — there is
 * no shared package between the backend and cdktf-infra, so this list is duplicated on purpose.
 */
const SECRET_ENVS = ["ADMIN_PASSWORD", "SERVER_PASSWORD", "RCON_PASSWORD"] as const;
const SECRET_NAME = "palworld-secrets";

// First boot runs SteamCMD and pulls several GB before the server ever listens. 40 min is
// comfortable for that on a slow link while staying under the deploy activity's 80 min timeout.
const STARTUP_WINDOW_SECONDS = 2400;

export interface PalworldConfig {
  readonly namespace?: string;
  readonly webRepo?: string;
  readonly webTag?: string;
  readonly storage?: string;
  /** Resolved settings map (schema defaults + user overrides), keyed by env var name. */
  readonly settings?: Record<string, string>;
  readonly cpuRequest?: string;
  readonly memoryRequest?: string;
  readonly cpuLimit?: string;
  readonly memoryLimit?: string;
}

export class PalworldApp extends Construct {
  constructor(scope: Construct, id: string, config: PalworldConfig) {
    super(scope, id);

    const namespaceName = config.namespace || "palworld";
    const image = `${config.webRepo || "thijsvanloef/palworld-server-docker"}:${config.webTag || "latest"}`;
    const storageSize = config.storage || "20Gi";
    const settings = config.settings ?? {};

    // The image's own PUID/PGID handling assumes a Docker-style bind mount; on a PVC the pod has
    // to actually run as that uid/gid or /palworld is not writable.
    const puid = Number(settings.PUID ?? "1000");
    const pgid = Number(settings.PGID ?? "1000");

    const ns = new Namespace(this, "ns", {
      metadata: { name: namespaceName },
    });

    const dataPvc = new PersistentVolumeClaim(this, "data-pvc", {
      metadata: {
        name: "palworld-data",
        namespace: ns.metadata.name,
      },
      spec: {
        accessModes: ["ReadWriteOnce"],
        resources: { requests: { storage: storageSize } },
      },
      // Every PVC in this repo sets this — a WaitForFirstConsumer StorageClass would otherwise
      // deadlock the apply.
      waitUntilBound: false,
    });

    const ports: GamePort[] = [
      { name: "game", port: GAME_PORT, protocol: "UDP", exposeOnHost: true },
      { name: "query", port: QUERY_PORT, protocol: "UDP", exposeOnHost: true },
      // Control ports stay cluster-internal — reached through the Service below, never the node.
      { name: "rest", port: REST_PORT, protocol: "TCP" },
      { name: "rcon", port: RCON_PORT, protocol: "TCP" },
    ];

    const selector = { app: `palworld-${id}` };

    new Deployment(this, "deployment", {
      metadata: {
        name: "palworld",
        namespace: ns.metadata.name,
        labels: selector,
      },
      spec: {
        replicas: "1",
        // MANDATORY, and the single most likely way to brick this app. SyncConfigActivity does an
        // unconditional `kubectl rollout restart` on every config save; with hostPort (only one
        // pod can bind 8211) and a ReadWriteOnce PVC, the default RollingUpdate deadlocks
        // permanently — the new pod stays Pending on the port/volume while the old one is never
        // torn down. Recreate removes the old pod first.
        strategy: { type: "Recreate" },
        // Kubernetes' own stall detector, enforced independently of the `timeouts` block below.
        // Must exceed the startupProbe window or the API server fails the rollout while SteamCMD
        // is still legitimately downloading. Same reasoning as vllm.ts.
        progressDeadlineSeconds: STARTUP_WINDOW_SECONDS + 60,
        selector: { matchLabels: selector },
        template: {
          metadata: { labels: selector },
          spec: {
            // The image traps SIGTERM to RCON-save and shut down cleanly. The 30s default can
            // truncate a world save mid-write — this is a data-loss guard, not tidiness.
            terminationGracePeriodSeconds: 60,
            securityContext: {
              runAsUser: String(puid),
              runAsGroup: String(pgid),
              fsGroup: String(pgid),
            },
            container: [
              {
                name: "palworld",
                image,
                imagePullPolicy: "IfNotPresent",
                port: buildGameContainerPorts(ports),
                // Inline env, NOT envFrom + ConfigMap: a ConfigMap change does not alter the pod
                // template, so `cdktf deploy` would report "no changes" on a settings edit and
                // the rollout would depend entirely on SyncConfigActivity's separate blind
                // restart. Sorted so the Terraform plan diff is stable and reviewable.
                env: [
                  ...Object.entries(settings)
                    // Strip secrets defensively. resolveAppSettings() already excludes them, but
                    // if one ever reaches this map — a stale stored value, a hand-built
                    // APP_SETTINGS_JSON — spreading it here would write the plaintext into
                    // cdk.tf.json and the tfstate on disk. Kubernetes takes the LAST duplicate
                    // env entry, so the secretKeyRef below would still win at runtime and the
                    // leak would be completely invisible in behaviour.
                    .filter(([name]) => !SECRET_ENVS.includes(name as (typeof SECRET_ENVS)[number]))
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([name, value]) => ({ name, value })),
                  // Never literals — DeployAppActivity generates these and writes them to a
                  // Secret, so they never reach synthesized Terraform on disk or Temporal history.
                  ...SECRET_ENVS.map((name) => ({
                    name,
                    valueFrom: {
                      secretKeyRef: {
                        name: SECRET_NAME,
                        key: name,
                        // The Secret is created AFTER this apply (the namespace doesn't exist
                        // until it lands), so the pod must tolerate its absence on the very first
                        // reconcile rather than hard-failing.
                        optional: true,
                      },
                    },
                  })),
                ],
                volumeMount: [{ name: "data", mountPath: "/palworld" }],
                resources: {
                  requests: {
                    cpu: config.cpuRequest || "2",
                    // Deliberately below the game's recommended 16Gi so the pod can still be
                    // scheduled alongside this platform's own cluster stack (~5Gi) on a 32GB node.
                    memory: config.memoryRequest || "8Gi",
                  },
                  limits: {
                    cpu: config.cpuLimit || "6",
                    memory: config.memoryLimit || "16Gi",
                  },
                },
                // TCP on the REST port, not the UDP game port: the game socket binds early, while
                // the REST listener only comes up once the world has finished loading — so this
                // is the signal that actually means "players can join".
                startupProbe: {
                  tcpSocket: [{ port: String(REST_PORT) }],
                  initialDelaySeconds: 30,
                  periodSeconds: 10,
                  timeoutSeconds: 5,
                  failureThreshold: Math.ceil(STARTUP_WINDOW_SECONDS / 10),
                },
                readinessProbe: {
                  tcpSocket: [{ port: String(REST_PORT) }],
                  periodSeconds: 15,
                  timeoutSeconds: 5,
                  failureThreshold: 3,
                },
                livenessProbe: {
                  tcpSocket: [{ port: String(REST_PORT) }],
                  periodSeconds: 30,
                  timeoutSeconds: 5,
                  failureThreshold: 5,
                },
              },
            ],
            volume: [
              {
                name: "data",
                persistentVolumeClaim: { claimName: dataPvc.metadata.name },
              },
            ],
          },
        },
      },
      timeouts: {
        create: "70m",
        update: "70m",
      },
    });

    createGameServerService(this, "service", {
      namespace: namespaceName,
      serviceName: "palworld",
      selector,
      ports,
    });

    // tcp_connect, not the default http_2xx: the REST API requires a bearer token, so an HTTP
    // probe would get a 401 and report the server down. Needs blackbox-exporter's tcp_connect
    // module (constructs/blackbox-exporter.ts) — existing clusters need ObservabilityStack
    // re-applied before this resolves.
    createAppProbe(this, "probe", {
      namespace: namespaceName,
      serviceName: "palworld",
      servicePort: REST_PORT,
      module: "tcp_connect",
    });
  }
}

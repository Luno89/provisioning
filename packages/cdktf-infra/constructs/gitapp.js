import { Construct } from "constructs";
import { Namespace } from "../.gen/providers/kubernetes/namespace/index.js";
import { Deployment } from "../.gen/providers/kubernetes/deployment/index.js";
import { Service } from "../.gen/providers/kubernetes/service/index.js";
import { PersistentVolumeClaim } from "../.gen/providers/kubernetes/persistent-volume-claim/index.js";
import { createAppIngress } from "../lib/app-ingress.js";
import { createAppProbe } from "../lib/app-probe.js";
export class GitappApp extends Construct {
    constructor(scope, id, config) {
        super(scope, id);
        const namespaceName = config.namespace || "gitapp";
        /**
         * Service-binding projection, computed by the backend and passed as JSON.
         *
         * Same pattern as APP_SPEC_JSON: cdktf-infra is a separate workspace, so a shared type would be
         * a build-order dependency for no gain — and the decision of WHAT to mount belongs where it can
         * be unit-tested. Absent means no bindings, which is every app that declares no dependencies.
         */
        const binding = (() => {
            const raw = process.env.BINDINGS_JSON;
            if (!raw)
                return { volumes: [], volumeMounts: [], env: [] };
            try {
                return JSON.parse(raw);
            }
            catch (err) {
                throw new Error(`BINDINGS_JSON is not valid JSON: ${err.message}`);
            }
        })();
        const containerPort = config.containerPort || 8080;
        const serviceType = config.serviceType || (process.env.SELF_MANAGED_K8S === "true" ? "NodePort" : "LoadBalancer");
        /**
         * Configuration for the deployed project, one "KEY=VALUE" per line.
         *
         * Same escape hatch as tabbyapi.ts's extraEnv, and here it is not optional in practice: a built
         * project had NO way to be given an environment at all, so anything needing a token or a URL
         * deployed and then exited. Measured end to end — the MCP server this platform built pushed,
         * built, deployed, and crash-looped on "GITHUB_TOKEN environment variable is required", which
         * is the app behaving correctly and the platform having nowhere to put the answer.
         */
        /**
         * PORT, first, so the app knows where to listen.
         *
         * The Service and the readiness probe both target `containerPort`, and nothing told the
         * application what that was — so a server written to read `process.env.PORT` bound to its own
         * default or, in the case measured here, decided it was not being run as a service at all and
         * fell back to stdio, read EOF and exited 0 forever. The convention every platform uses, and
         * its absence looks exactly like a broken app.
         *
         * Before the project's own env, so an explicit PORT in that wins.
         */
        const envVars = [
            { name: "PORT", value: String(containerPort) },
        ];
        for (const line of (config.env ?? '').split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#'))
                continue;
            const eq = trimmed.indexOf('=');
            if (eq === -1)
                continue;
            envVars.push({ name: trimmed.slice(0, eq).trim(), value: trimmed.slice(eq + 1).trim() });
        }
        const ns = new Namespace(this, "ns", {
            metadata: {
                name: namespaceName,
            },
        });
        let dataPvc;
        if (config.storage) {
            dataPvc = new PersistentVolumeClaim(this, "data-pvc", {
                metadata: {
                    name: "gitapp-data",
                    namespace: ns.metadata.name,
                },
                spec: {
                    accessModes: ["ReadWriteOnce"],
                    resources: {
                        requests: {
                            storage: config.storage,
                        },
                    },
                },
                waitUntilBound: false,
            });
        }
        new Deployment(this, "gitapp-deployment", {
            // Confirmed live: the default (true) blocks `terraform apply` until the Deployment's
            // pods report Ready — but the imagePullSecret this Deployment needs doesn't exist until
            // *after* DeployAppActivity's `infra.deploy()` call returns (see DeployAppActivity.ts),
            // since it has to be created inside the namespace this same apply creates. That's a
            // genuine deadlock: apply waits for pods that can't pull their image until apply
            // finishes. Disabling the wait breaks the cycle — kubelet's own pull-retry picks the
            // secret up within its normal backoff once it lands, no different from any other
            // eventually-consistent K8s rollout this platform already tolerates elsewhere.
            waitForRollout: false,
            metadata: {
                name: "gitapp",
                namespace: ns.metadata.name,
                labels: { app: `gitapp-${id}` },
            },
            spec: {
                replicas: "1",
                selector: {
                    matchLabels: { app: `gitapp-${id}` },
                },
                template: {
                    metadata: {
                        labels: { app: `gitapp-${id}` },
                    },
                    spec: {
                        // Registry pushed to by RunPipelineActivity is authenticated (see GiteaService) —
                        // the Deployment needs its own pull credentials, created just before this stack is
                        // applied (see DeployAppActivity's gitapp-gated imagePullSecret step).
                        imagePullSecrets: [{ name: "gitea-registry" }],
                        container: [
                            {
                                name: "gitapp",
                                image: `${config.webRepo}:${config.webTag}`,
                                port: [{ containerPort }],
                                ...((envVars.length || binding.env.length) ? { env: [...envVars, ...binding.env] } : {}),
                                envFrom: [
                                    {
                                        secretRef: {
                                            name: `${namespaceName}-secrets`,
                                            optional: true,
                                        },
                                    },
                                ],
                                resources: {
                                    limits: { cpu: "1", memory: "1G" },
                                    requests: { cpu: "100m", memory: "128M" },
                                },
                                /**
                                 * Service bindings are mounted as files — see lib/service-binding.ts. The backend
                                 * computes the fragments so the decision is unit-tested; this only spreads them.
                                 */
                                ...((dataPvc || binding.volumeMounts.length) ? {
                                    volumeMount: [
                                        ...(dataPvc ? [{ name: "data", mountPath: "/data" }] : []),
                                        ...binding.volumeMounts,
                                    ],
                                } : {}),
                                // No fixed health-check path — unlike this platform's known app types, an
                                // arbitrary sibling project has no guaranteed /health endpoint. TCP-socket
                                // checks against the declared port are the only universal signal available.
                                readinessProbe: {
                                    tcpSocket: [{ port: String(containerPort) }],
                                    periodSeconds: 10,
                                    failureThreshold: 6,
                                },
                                livenessProbe: {
                                    tcpSocket: [{ port: String(containerPort) }],
                                    periodSeconds: 15,
                                    failureThreshold: 6,
                                    initialDelaySeconds: 15,
                                },
                            },
                        ],
                        ...((dataPvc || binding.volumes.length) ? {
                            volume: [
                                ...(dataPvc ? [{
                                        name: "data",
                                        persistentVolumeClaim: { claimName: dataPvc.metadata.name },
                                    }] : []),
                                ...binding.volumes,
                            ],
                        } : {}),
                    },
                },
            },
            timeouts: {
                create: "10m",
                update: "10m",
            },
        });
        new Service(this, "gitapp-service", {
            metadata: {
                name: "gitapp",
                namespace: ns.metadata.name,
            },
            spec: {
                type: serviceType,
                selector: { app: `gitapp-${id}` },
                port: [{ port: containerPort, targetPort: String(containerPort) }],
            },
        });
        createAppIngress(this, "ingress", {
            namespace: namespaceName,
            serviceName: "gitapp",
            servicePort: containerPort,
            hostname: `${namespaceName}.apps.local`,
        });
        createAppProbe(this, "probe", {
            namespace: namespaceName,
            serviceName: "gitapp",
            servicePort: containerPort,
        });
    }
}

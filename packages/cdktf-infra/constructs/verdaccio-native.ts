import { Construct } from "constructs";
import { Namespace } from "../.gen/providers/kubernetes/namespace/index.js";
import { Deployment } from "../.gen/providers/kubernetes/deployment/index.js";
import { Service } from "../.gen/providers/kubernetes/service/index.js";
import { ConfigMap } from "../.gen/providers/kubernetes/config-map/index.js";
import { PersistentVolumeClaim } from "../.gen/providers/kubernetes/persistent-volume-claim/index.js";
import { type VpnConfig, VpnService } from "../lib/vpn-service.js";
import { createAppIngress } from "../lib/app-ingress.js";
import { createAppProbe } from "../lib/app-probe.js";

/**
 * Verdaccio — an npm registry inside the cluster, so a sandbox can install without the internet.
 *
 * ── THE PROBLEM THIS SOLVES ──
 * A leaf's sandbox denies all egress except DNS and whatever its persona names. That is the whole
 * isolation model, and it is why `npm install` fails there: `registry.npmjs.org` answers
 * "connection refused". Measured — an agent spent three attempts and 62,947 tokens discovering it.
 *
 * The obvious fix is to let sandboxes reach the internet on 443. That is model-authored code, with
 * a deploy pipeline downstream of it, given general outbound access — the prompt-injection risk
 * named in the plan as the defining security property of the system.
 *
 * ── WHY A MIRROR IS DIFFERENT ──
 * This moves the internet access to ONE pod that runs no model output. Sandboxes reach it by
 * NAMESPACE, which is a rule the egress model already expresses exactly — no CIDR guesswork, which
 * would not work anyway since a public registry is a CDN behind rotating addresses.
 *
 * What a sandbox can reach becomes: DNS, its Gitea, and a registry that only ever serves packages.
 * It cannot POST anywhere, cannot reach an arbitrary host, and cannot exfiltrate to one.
 *
 * ── UPLINK IS THE ONE THING THAT MUST WORK ──
 * Verdaccio is a caching proxy: it needs to reach npmjs itself. It runs in a normal app namespace
 * with no NetworkPolicy, so it does — and that asymmetry is the entire point. One auditable hop out,
 * rather than one per agent.
 */
export interface VerdaccioNativeConfig extends VpnConfig {
  readonly namespace?: string;
  readonly webRepo?: string;
  readonly webTag?: string;
  readonly serviceType?: string;
  /** Where packages are proxied from. Changed for an internal registry or a different mirror. */
  readonly upstream?: string;
  /** Cache size. Every package a build pulls is stored here, so it grows with what gets built. */
  readonly storage?: string;
  readonly memoryLimit?: string;
}

export class VerdaccioNativeApp extends Construct {
  constructor(scope: Construct, id: string, config: VerdaccioNativeConfig = {}) {
    super(scope, id);

    const namespaceName = config.namespace || "verdaccio";
    const image = `${config.webRepo || "verdaccio/verdaccio"}:${config.webTag || "6"}`;
    const serviceType = config.serviceType || (process.env.SELF_MANAGED_K8S === "true" ? "NodePort" : "LoadBalancer");
    const upstream = config.upstream || "https://registry.npmjs.org/";
    const storage = config.storage || "20Gi";
    const memoryLimit = config.memoryLimit || "1Gi";

    const ns = new Namespace(this, "ns", { metadata: { name: namespaceName } });

    /**
     * Written out rather than relying on the image's defaults.
     *
     * The defaults differ between major versions, and the two settings that matter here are exactly
     * the ones that would be silently wrong: anonymous READ must be allowed, because a sandbox has
     * no credentials and never will; and PUBLISH must be denied, because nothing in a sandbox
     * should be able to put a package where the next build will find it. A mirror that accepted
     * publishes from model-authored code would be a supply-chain hole with extra steps.
     */
    const configYaml = [
      "storage: /verdaccio/storage",
      "",
      "uplinks:",
      "  npmjs:",
      `    url: ${upstream}`,
      // A slow uplink must not hang a build forever; the agent has a step budget.
      "    timeout: 30s",
      "    maxage: 2m",
      "    cache: true",
      "",
      "packages:",
      "  '@*/*':",
      "    access: $all",
      "    publish: $authenticated",
      "    proxy: npmjs",
      "  '**':",
      "    access: $all",
      "    publish: $authenticated",
      "    proxy: npmjs",
      "",
      // No htpasswd file and no users, so `$authenticated` is a set nobody is in — publish is
      // refused for everyone rather than merely inconvenient.
      "auth:",
      "  htpasswd:",
      "    file: /verdaccio/storage/htpasswd",
      "    max_users: -1",
      "",
      "log: { type: stdout, format: pretty-timestamped, level: warn }",
      "",
      "listen: 0.0.0.0:4873",
      "",
      // Sandboxes are inside the cluster; a browser is not the client here.
      "web:",
      "  enable: true",
      "  title: Koala package mirror",
      "",
    ].join("\n");

    const conf = new ConfigMap(this, "config", {
      metadata: { name: "verdaccio-config", namespace: ns.metadata.name },
      data: { "config.yaml": configYaml },
    });

    const pvc = new PersistentVolumeClaim(this, "storage-pvc", {
      metadata: { name: "verdaccio-storage-pvc", namespace: ns.metadata.name },
      spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage } } },
      waitUntilBound: false,
    });

    const podSpec: any = {
      /**
       * The image runs as uid 10001 and writes to its storage directory.
       *
       * `fsGroup` is what makes the mounted volume writable by that user — without it the pod comes
       * up and every package write fails, which presents as an empty cache and installs that go to
       * the uplink every single time.
       */
      securityContext: { runAsUser: "10001", runAsGroup: "65533", fsGroup: "65533" },
      container: [
        {
          name: "verdaccio",
          image,
          // A ConfigMap mount is read-only and Verdaccio rewrites its config on start. Copying to a
          // writable path first sidesteps that — the same trick searxng-native.ts uses.
          command: ["/bin/sh", "-c"],
          args: [[
            "mkdir -p /verdaccio/conf",
            "&& cp /config-src/config.yaml /verdaccio/conf/config.yaml",
            "&& exec verdaccio --config /verdaccio/conf/config.yaml",
          ].join(" ")],
          port: [{ containerPort: 4873 }],
          volumeMount: [
            { name: "storage", mountPath: "/verdaccio/storage" },
            { name: "config-src", mountPath: "/config-src", readOnly: true },
            // /verdaccio itself must be writable for the conf copy above; the image's root is not.
            { name: "conf", mountPath: "/verdaccio/conf" },
          ],
          resources: {
            limits: { memory: memoryLimit, cpu: "1000m" },
            requests: { memory: "128Mi", cpu: "50m" },
          },
          livenessProbe: {
            httpGet: { path: "/-/ping", port: "4873" },
            initialDelaySeconds: 20,
            periodSeconds: 20,
          },
          readinessProbe: {
            httpGet: { path: "/-/ping", port: "4873" },
            initialDelaySeconds: 10,
            periodSeconds: 10,
          },
        },
      ],
      volume: [
        { name: "storage", persistentVolumeClaim: { claimName: pvc.metadata.name } },
        { name: "config-src", configMap: { name: conf.metadata.name } },
        { name: "conf", emptyDir: {} },
      ],
    };

    VpnService.apply(this, ns.metadata.name, podSpec, config);

    new Deployment(this, "verdaccio-deployment", {
      metadata: { name: "verdaccio", namespace: ns.metadata.name, labels: { app: `verdaccio-${id}` } },
      spec: {
        replicas: "1",
        // ReadWriteOnce cache volume: a rolling update would deadlock on it.
        strategy: { type: "Recreate" },
        selector: { matchLabels: { app: `verdaccio-${id}` } },
        template: { metadata: { labels: { app: `verdaccio-${id}` } }, spec: podSpec },
      },
    });

    new Service(this, "verdaccio-service", {
      metadata: { name: "verdaccio", namespace: ns.metadata.name },
      spec: {
        type: serviceType,
        selector: { app: `verdaccio-${id}` },
        port: [{ port: 4873, targetPort: "4873" }],
      },
    });

    createAppIngress(this, "ingress", {
      namespace: namespaceName,
      serviceName: "verdaccio",
      servicePort: 4873,
      hostname: `${namespaceName}.apps.local`,
    });

    createAppProbe(this, "probe", {
      namespace: namespaceName,
      serviceName: "verdaccio",
      servicePort: 4873,
      path: "/-/ping",
    });
  }
}

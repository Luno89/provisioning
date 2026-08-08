import { randomBytes } from "node:crypto";
import { Construct } from "constructs";
import { Namespace } from "../.gen/providers/kubernetes/namespace/index.js";
import { Deployment } from "../.gen/providers/kubernetes/deployment/index.js";
import { Service } from "../.gen/providers/kubernetes/service/index.js";
import { Secret } from "../.gen/providers/kubernetes/secret/index.js";
import { type VpnConfig, VpnService } from "../lib/vpn-service.js";
import { createAppIngress } from "../lib/app-ingress.js";
import { createAppProbe } from "../lib/app-probe.js";

/**
 * Crawl4AI — headless Chromium behind an HTTP API, returning markdown instead of HTML.
 *
 * ── WHY THIS IS DEPLOYABLE RATHER THAN A LIBRARY CALL ──
 * The built-in fetcher strips tags from raw HTML. That is adequate for a static page and returns
 * nothing at all for anything rendered client-side, which is most of the web — and it fails with a
 * 200, so the agent reads an empty page as a page with nothing on it. Measured on
 * `weather.com/.../air-quality`: the built-in fetcher returned 200 and no figure anywhere; this
 * service returned 3,618 characters of markdown with the figure in it. That difference is a
 * conversation where the model searched, fetched twice, searched again, and never answered.
 *
 * ── THE ONE ENV VAR THAT MATTERS ──
 * `CRAWL4AI_API_TOKEN` is not only authentication. The image's entrypoint resolves its bind
 * address from it: with no credential it binds `127.0.0.1` and refuses to expose itself, which in
 * Kubernetes means a Service with a healthy pod behind it that never answers. With one it binds
 * `[::]` and the auth gate goes active. Verified by reading the shipped entrypoint.sh and
 * server.py's `_resolve_auth()`, both of which say so explicitly.
 *
 * Clients authenticate by sending this same token as `Authorization: Bearer`. Note the service also
 * exposes `POST /token`, which is a dead end for a deployment configured this way — it reads the
 * token from the config FILE with no environment fallback, so it answers 403 forever while every
 * other route authenticates normally. See lib/web-tools.ts.
 */
export interface Crawl4aiNativeConfig extends VpnConfig {
  readonly namespace?: string;
  readonly webRepo?: string;
  readonly webTag?: string;
  readonly serviceType?: string;
  /** The `api_token`. Generated per-deployment when absent — see above, it is not optional. */
  readonly apiToken?: string;
  /**
   * Memory ceiling. Chromium is not a small dependency: the service reported 77% memory use while
   * completely idle, and a page with a heavy JS bundle is what actually decides the peak.
   */
  readonly memoryLimit?: string;
  /**
   * `/dev/shm`, which Chromium uses for its renderer processes.
   *
   * Kubernetes gives a container 64MB by default. Chromium does not fail loudly when it runs out
   * — it renders an empty page, which arrives as a successful crawl of a blank document. That is
   * the single most likely misconfiguration here and the hardest to read from the outside, which
   * is why web-tools.ts treats an empty render as a failure and falls back rather than believing
   * it.
   */
  readonly shmSize?: string;
}

export class Crawl4aiNativeApp extends Construct {
  constructor(scope: Construct, id: string, config: Crawl4aiNativeConfig = {}) {
    super(scope, id);

    const namespaceName = config.namespace || "crawl4ai";
    const image = `${config.webRepo || "unclecode/crawl4ai"}:${config.webTag || "latest"}`;
    const serviceType = config.serviceType || (process.env.SELF_MANAGED_K8S === "true" ? "NodePort" : "LoadBalancer");
    const memoryLimit = config.memoryLimit || "4Gi";
    const shmSize = config.shmSize || "1Gi";

    const ns = new Namespace(this, "ns", {
      metadata: { name: namespaceName },
    });

    const apiToken = config.apiToken || randomBytes(32).toString("hex");

    const secret = new Secret(this, "secret", {
      metadata: { name: "crawl4ai-secret", namespace: ns.metadata.name },
      // Plaintext — the provider base64-encodes `data` itself (see searxng-native.ts).
      data: { api_token: apiToken },
      type: "Opaque",
    });

    const podSpec: any = {
      container: [
        {
          name: "crawl4ai",
          image,
          env: [
            {
              name: "CRAWL4AI_API_TOKEN",
              valueFrom: { secretKeyRef: { name: secret.metadata.name, key: "api_token" } },
            },
            { name: "CRAWL4AI_PORT", value: "11235" },
          ],
          port: [{ containerPort: 11235 }],
          volumeMount: [{ name: "shm", mountPath: "/dev/shm" }],
          resources: {
            limits: { memory: memoryLimit, cpu: "2000m" },
            // A request well under the limit on purpose: the pod is idle most of the time and
            // only spikes while a page renders. Requesting the peak would reserve several GB
            // permanently on a node that is also holding a 20GB model.
            requests: { memory: "512Mi", cpu: "200m" },
          },
        },
      ],
      volume: [
        {
          name: "shm",
          // Memory-backed, like /dev/shm actually is. Note this counts against the container's
          // memory limit — the same trap that OOMKilled the TabbyAPI pod when its shm was sized
          // without accounting for it.
          emptyDir: { medium: "Memory", sizeLimit: shmSize },
        },
      ],
    };

    VpnService.apply(this, ns.metadata.name, podSpec, config);

    new Deployment(this, "crawl4ai-deployment", {
      metadata: {
        name: "crawl4ai",
        namespace: ns.metadata.name,
        labels: { app: `crawl4ai-${id}` },
      },
      spec: {
        replicas: "1",
        selector: { matchLabels: { app: `crawl4ai-${id}` } },
        template: {
          metadata: { labels: { app: `crawl4ai-${id}` } },
          spec: podSpec,
        },
      },
    });

    new Service(this, "crawl4ai-service", {
      metadata: { name: "crawl4ai", namespace: ns.metadata.name },
      spec: {
        type: serviceType,
        selector: { app: `crawl4ai-${id}` },
        port: [{ port: 11235, targetPort: "11235" }],
      },
    });

    createAppIngress(this, "ingress", {
      namespace: namespaceName,
      serviceName: "crawl4ai",
      servicePort: 11235,
      hostname: `${namespaceName}.apps.local`,
    });

    createAppProbe(this, "probe", {
      namespace: namespaceName,
      serviceName: "crawl4ai",
      servicePort: 11235,
      // Every other route sits behind the auth gate and answers 401, which blackbox-exporter would
      // report as down forever. `/health` is one of the two paths the gate leaves public.
      path: "/health",
    });
  }
}

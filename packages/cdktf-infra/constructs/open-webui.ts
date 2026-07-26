import { Construct } from "constructs";
import { Namespace } from "../.gen/providers/kubernetes/namespace/index.js";
import { Deployment } from "../.gen/providers/kubernetes/deployment/index.js";
import { Service } from "../.gen/providers/kubernetes/service/index.js";
import { PersistentVolumeClaim } from "../.gen/providers/kubernetes/persistent-volume-claim/index.js";
import { createAppIngress } from "../lib/app-ingress.js";
import { createAppProbe } from "../lib/app-probe.js";

export interface OpenWebUiConfig {
  readonly namespace?: string;
  readonly webRepo?: string;
  readonly webTag?: string;
  readonly openaiApiBaseUrl?: string;
  readonly openaiApiKey?: string;
  readonly serviceType?: string;
  readonly storage?: string;
  // The model has no inherent internet access — it can only "browse" via a tool Open WebUI
  // executes server-side and feeds the results back to it. That's a distinct opt-in feature
  // from just wiring up a chat backend, and none of this construct's config touched it before.
  readonly enableWebSearch?: boolean;
  // duckduckgo needs no API key/account and no extra infrastructure (unlike searxng, which
  // needs a self-hosted instance, or tavily/brave/serper/google_pse, which need paid keys) —
  // matches this platform's zero-setup-by-default philosophy elsewhere (mock cloud credentials,
  // etc.). Still overridable for anyone who wants a more reliable/less rate-limited provider.
  readonly webSearchEngine?: string;
  readonly webSearchApiKey?: string;
}

export class OpenWebUiApp extends Construct {
  constructor(scope: Construct, id: string, config: OpenWebUiConfig = {}) {
    super(scope, id);

    const namespaceName = config.namespace || "open-webui";
    // webRepo/webTag (not a hardcoded image) so this flows through the same k3d
    // pullAndImportImage pipeline every other native app image uses — the image the pod
    // requests has to match exactly what got imported into the cluster's containerd.
    const image = `${config.webRepo || "ghcr.io/open-webui/open-webui"}:${config.webTag && config.webTag !== 'latest' ? config.webTag : "main"}`;
    const storageSize = config.storage || "5Gi";
    const serviceType = config.serviceType || (process.env.SELF_MANAGED_K8S === "true" ? "NodePort" : "LoadBalancer");

    const ns = new Namespace(this, "ns", {
      metadata: {
        name: namespaceName,
      },
    });

    const dataPvc = new PersistentVolumeClaim(this, "data-pvc", {
      metadata: {
        name: "open-webui-data",
        namespace: ns.metadata.name,
      },
      spec: {
        accessModes: ["ReadWriteOnce"],
        resources: {
          requests: {
            storage: storageSize,
          },
        },
      },
      waitUntilBound: false,
    });

    const env: { name: string; value: string }[] = [
      // Open WebUI's Ollama integration is on by default and probes for a local Ollama server
      // on every page load if left enabled — pointless and noisy when the only backend is an
      // OpenAI-API-compatible one (vLLM).
      { name: "ENABLE_OLLAMA_API", value: "false" },
      { name: "ENABLE_OPENAI_API", value: "true" },
      // vLLM's OpenAI-compatible server doesn't check the API key, but Open WebUI's client
      // refuses to make requests with a completely empty one — any non-empty placeholder works.
      { name: "OPENAI_API_KEY", value: config.openaiApiKey || "not-needed" },
    ];
    if (config.openaiApiBaseUrl) {
      env.push({ name: "OPENAI_API_BASE_URL", value: config.openaiApiBaseUrl });
    }

    // On by default — confirmed live: with this unset (the prior state of this construct), the
    // model has no way to answer anything requiring current information, and there's no
    // in-product signal explaining why ("can't call the internet" just looks like a dumb model).
    // duckduckgo needs no API key and no extra infrastructure, so "on by default" is actually
    // free, unlike every other engine option below.
    const enableWebSearch = config.enableWebSearch !== false;
    const webSearchEngine = config.webSearchEngine || "duckduckgo";
    // Not ENABLE_RAG_WEB_SEARCH/RAG_WEB_SEARCH_ENGINE — confirmed live against the actual running
    // container (`grep` on its own open_webui/config.py) that the current image (pulled via the
    // unpinned ":main" tag above) reads ENABLE_WEB_SEARCH/WEB_SEARCH_ENGINE; the "RAG_"-prefixed
    // names are stale/from an older upstream version and are never read by this code path at all
    // — env vars only ever seed PersistentConfig once, on a pod's first-ever boot (see
    // lib/openwebui-admin.ts's docstring), so this wasn't just cosmetically wrong, it meant web
    // search silently never actually turned on for any fresh deployment.
    env.push({ name: "ENABLE_WEB_SEARCH", value: enableWebSearch ? "true" : "false" });
    if (enableWebSearch) {
      env.push({ name: "WEB_SEARCH_ENGINE", value: webSearchEngine });
      if (config.webSearchApiKey) {
        // Only single-API-key engines are supported through this one field — searxng
        // (SEARXNG_QUERY_URL) and google_pse (two separate fields) need more than a key and
        // aren't covered here; switch engine away from duckduckgo only for ones this handles.
        const apiKeyEnvVar: Record<string, string> = {
          tavily: "TAVILY_API_KEY",
          brave: "BRAVE_SEARCH_API_KEY",
          serper: "SERPER_API_KEY",
          bing: "BING_SEARCH_V7_SUBSCRIPTION_KEY",
        };
        const varName = apiKeyEnvVar[webSearchEngine];
        if (varName) env.push({ name: varName, value: config.webSearchApiKey });
      }
    }

    new Deployment(this, "open-webui-deployment", {
      metadata: {
        name: "open-webui",
        namespace: ns.metadata.name,
        labels: { app: `open-webui-${id}` },
      },
      spec: {
        replicas: "1",
        selector: {
          matchLabels: { app: `open-webui-${id}` },
        },
        template: {
          metadata: {
            labels: { app: `open-webui-${id}` },
          },
          spec: {
            container: [
              {
                name: "open-webui",
                image,
                env,
                port: [{ containerPort: 8080 }],
                resources: {
                  limits: { cpu: "2", memory: "2G" },
                  requests: { cpu: "250m", memory: "512M" },
                },
                volumeMount: [{ name: "data", mountPath: "/app/backend/data" }],
                // Open WebUI's own image can take a while to run its first-boot migrations —
                // a startupProbe (rather than a short initialDelaySeconds) avoids a restart
                // loop on slower disks without weakening liveness detection afterwards.
                startupProbe: {
                  httpGet: { path: "/health", port: "8080" },
                  periodSeconds: 5,
                  failureThreshold: 60, // ~5 min
                },
                livenessProbe: {
                  httpGet: { path: "/health", port: "8080" },
                  periodSeconds: 15,
                  failureThreshold: 3,
                },
                readinessProbe: {
                  httpGet: { path: "/health", port: "8080" },
                  periodSeconds: 10,
                  failureThreshold: 3,
                },
              },
            ],
            volume: [
              {
                name: "data",
                persistentVolumeClaim: {
                  claimName: dataPvc.metadata.name,
                },
              },
            ],
          },
        },
      },
      timeouts: {
        create: "10m",
        update: "10m",
      },
    });

    new Service(this, "open-webui-service", {
      metadata: {
        name: "open-webui",
        namespace: ns.metadata.name,
      },
      spec: {
        type: serviceType,
        selector: { app: `open-webui-${id}` },
        port: [{ port: 8080, targetPort: "8080" }],
      },
    });

    createAppIngress(this, "ingress", {
      namespace: namespaceName,
      serviceName: "open-webui",
      servicePort: 8080,
      hostname: `${namespaceName}.apps.local`,
    });

    createAppProbe(this, "probe", {
      namespace: namespaceName,
      serviceName: "open-webui",
      servicePort: 8080,
    });
  }
}

import { Construct } from "constructs";
import { Namespace } from "../.gen/providers/kubernetes/namespace/index.js";
import { Deployment } from "../.gen/providers/kubernetes/deployment/index.js";
import { Service } from "../.gen/providers/kubernetes/service/index.js";
import { PersistentVolumeClaim } from "../.gen/providers/kubernetes/persistent-volume-claim/index.js";

export interface OpenWebUiConfig {
  readonly namespace?: string;
  readonly webRepo?: string;
  readonly webTag?: string;
  readonly openaiApiBaseUrl?: string;
  readonly openaiApiKey?: string;
  readonly serviceType?: string;
  readonly storage?: string;
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
    const serviceType = config.serviceType || (process.env.KUBECONFIG_CONTEXT?.startsWith("k3d-") ? "NodePort" : "LoadBalancer");

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
                  httpGet: { path: "/health", port: 8080 },
                  periodSeconds: 5,
                  failureThreshold: 60, // ~5 min
                },
                livenessProbe: {
                  httpGet: { path: "/health", port: 8080 },
                  periodSeconds: 15,
                  failureThreshold: 3,
                },
                readinessProbe: {
                  httpGet: { path: "/health", port: 8080 },
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
  }
}

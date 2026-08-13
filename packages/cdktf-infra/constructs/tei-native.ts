import { Construct } from "constructs";
import { Namespace } from "../.gen/providers/kubernetes/namespace/index.js";
import { Deployment } from "../.gen/providers/kubernetes/deployment/index.js";
import { Service } from "../.gen/providers/kubernetes/service/index.js";
import { PersistentVolumeClaim } from "../.gen/providers/kubernetes/persistent-volume-claim/index.js";
import { type VpnConfig, VpnService } from "../lib/vpn-service.js";
import { createAppIngress } from "../lib/app-ingress.js";
import { createAppProbe } from "../lib/app-probe.js";

/**
 * Text Embeddings Inference — the thing that turns chunks into vectors.
 *
 * ── WHY NOT THE MODEL SERVER THAT IS ALREADY RUNNING ──
 * TabbyAPI exposes `POST /v1/embeddings` and answers 503 "No embedding models are currently
 * loaded", so the route exists and only wants a model. Loading one there would put embedding and
 * generation on the same GPU, and an ingest is a sustained batch job: embedding a corpus would
 * starve the agents of the card they are answering on, intermittently, in a way that looks like
 * the model being slow.
 *
 * A separate deployment also means the embedding model can be small and CPU-bound while generation
 * keeps the GPU, which is the right split — see the dimension note below.
 *
 * ── CPU AND 384 DIMENSIONS BY DEFAULT ──
 * `bge-small-en-v1.5` is 33M parameters and emits 384-dimensional vectors. That is not a
 * compromise chosen for the hardware, it is the one that decides whether Qdrant fits: at the
 * terabyte this is built for, binary-quantized 768-dim vectors need ~148 GB of RAM and 384-dim
 * need ~74 GB. Halving the dimension halves the only figure in this design that does not fit on
 * one machine.
 *
 * `gpu` is available for a rebuild that needs throughput more than it needs the card, but the
 * default deliberately does not compete for it.
 *
 * ── THE CONTAINER LISTENS ON 80 ──
 * Not 8080. Every published example maps `-p 8080:80`, and the 8080 in them is the host side.
 */
export interface TeiNativeConfig extends VpnConfig {
  readonly namespace?: string;
  readonly webRepo?: string;
  readonly webTag?: string;
  readonly serviceType?: string;
  /** Hugging Face model id. Changing this changes the vector dimension, so the collection must be rebuilt. */
  readonly modelId?: string;
  /** Set true to schedule on a GPU. Off by default — see above, it shares the card with generation. */
  readonly useGpu?: boolean;
  readonly memoryLimit?: string;
  /** Cache for downloaded weights, so a pod restart is not another download. */
  readonly storage?: string;
}

export class TeiNativeApp extends Construct {
  constructor(scope: Construct, id: string, config: TeiNativeConfig = {}) {
    super(scope, id);

    const namespaceName = config.namespace || "tei";
    const useGpu = config.useGpu === true;
    const defaultTag = useGpu ? "1.8.1" : "cpu-1.8.1";
    const image = `${config.webRepo || "ghcr.io/huggingface/text-embeddings-inference"}:${config.webTag || defaultTag}`;
    const serviceType = config.serviceType || (process.env.SELF_MANAGED_K8S === "true" ? "NodePort" : "LoadBalancer");
    const modelId = config.modelId || "BAAI/bge-small-en-v1.5";
    const memoryLimit = config.memoryLimit || "4Gi";
    const storage = config.storage || "10Gi";

    const ns = new Namespace(this, "ns", { metadata: { name: namespaceName } });

    const pvc = new PersistentVolumeClaim(this, "cache-pvc", {
      metadata: { name: "tei-cache-pvc", namespace: ns.metadata.name },
      spec: {
        accessModes: ["ReadWriteOnce"],
        resources: { requests: { storage } },
      },
      waitUntilBound: false,
    });

    const podSpec: any = {
      container: [
        {
          name: "tei",
          image,
          args: [
            "--model-id", modelId,
            // float32 on CPU: the float16 kernels the default would pick are GPU-only, and the
            // failure is at load time rather than at build time.
            ...(useGpu ? [] : ["--dtype", "float32"]),
            // Batching is where the throughput is. An ingest submits chunks in bulk, so a request
            // waiting a few milliseconds for company is a good trade.
            "--max-concurrent-requests", "64",
          ],
          env: [{ name: "HUGGINGFACE_HUB_CACHE", value: "/data" }],
          port: [{ containerPort: 80, name: "http" }],
          volumeMount: [{ name: "cache", mountPath: "/data" }],
          resources: {
            limits: {
              memory: memoryLimit,
              cpu: "4000m",
              ...(useGpu ? { "nvidia.com/gpu": "1" } : {}),
            },
            requests: { memory: "1Gi", cpu: "500m" },
          },
          livenessProbe: {
            httpGet: { path: "/health", port: "80" },
            // The first start downloads the weights. Too short a delay here restarts the pod
            // mid-download, forever, which presents as a model that never loads.
            initialDelaySeconds: 60,
            periodSeconds: 20,
          },
          readinessProbe: {
            httpGet: { path: "/health", port: "80" },
            initialDelaySeconds: 30,
            periodSeconds: 10,
            failureThreshold: 30,
          },
        },
      ],
      volume: [{ name: "cache", persistentVolumeClaim: { claimName: pvc.metadata.name } }],
    };

    VpnService.apply(this, ns.metadata.name, podSpec, config);

    new Deployment(this, "tei-deployment", {
      metadata: { name: "tei", namespace: ns.metadata.name, labels: { app: `tei-${id}` } },
      spec: {
        replicas: "1",
        // ReadWriteOnce cache PVC: a rolling update would deadlock on the volume.
        strategy: { type: "Recreate" },
        selector: { matchLabels: { app: `tei-${id}` } },
        template: { metadata: { labels: { app: `tei-${id}` } }, spec: podSpec },
      },
    });

    new Service(this, "tei-service", {
      metadata: { name: "tei", namespace: ns.metadata.name },
      spec: {
        type: serviceType,
        selector: { app: `tei-${id}` },
        port: [{ port: 80, targetPort: "80", name: "http" }],
      },
    });

    createAppIngress(this, "ingress", {
      namespace: namespaceName,
      serviceName: "tei",
      servicePort: 80,
      hostname: `${namespaceName}.apps.local`,
    });

    createAppProbe(this, "probe", {
      namespace: namespaceName,
      serviceName: "tei",
      servicePort: 80,
      path: "/health",
    });
  }
}

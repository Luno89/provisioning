import { Construct } from "constructs";
import { Namespace } from "../.gen/providers/kubernetes/namespace/index.js";
import { Deployment } from "../.gen/providers/kubernetes/deployment/index.js";
import { Service } from "../.gen/providers/kubernetes/service/index.js";
import { Secret } from "../.gen/providers/kubernetes/secret/index.js";
import { Manifest } from "../.gen/providers/kubernetes/manifest/index.js";
import { createAppIngress } from "../lib/app-ingress.js";
import { createAppProbe } from "../lib/app-probe.js";

export interface VllmConfig {
  readonly namespace?: string;
  readonly model?: string;
  readonly gpuCount?: number;
  readonly gpuVendor?: 'nvidia' | 'amd';
  readonly device?: string;
  readonly hfToken?: string;
  readonly cachePvc?: string;
  readonly serviceType?: string;
  readonly imageTag?: string;
  readonly shmSize?: string;
  readonly cpuLimit?: string;
  readonly memoryLimit?: string;
  readonly maxModelLen?: number;
  readonly gpuMemUtil?: number;
  readonly extraArgs?: string[];
  readonly toolCallingEnabled?: boolean;
  readonly toolCallParser?: string;
  readonly servedModelName?: string;
  readonly maxNumSeqs?: number;
  readonly dtype?: string;
  readonly enablePrefixCaching?: boolean;
}

export class VllmApp extends Construct {
  constructor(scope: Construct, id: string, config: VllmConfig = {}) {
    super(scope, id);

    const namespaceName = config.namespace || "vllm";
    const modelName = config.model || "meta-llama/Llama-3.2-3B-Instruct";
    const gpuCount = config.gpuCount !== undefined ? config.gpuCount : 1;
    const gpuVendor = config.gpuVendor || 'nvidia';
    const device = config.device || process.env.VLLM_DEVICE || process.env.VLLM_TARGET_DEVICE || (gpuCount > 0 ? (gpuVendor === 'amd' ? 'rocm' : 'cuda') : 'cpu');
    const hfToken = config.hfToken || process.env.HF_TOKEN || process.env.VLLM_HF_TOKEN || "";
    // hostPath, not a PersistentVolumeClaim: a PVC lives inside this app's namespace, so
    // destroying the app (namespace delete) cascades to the PVC, and local-path-provisioner's
    // default reclaimPolicy is Delete — it actively rm -rf's the cached weights on every
    // destroy/redeploy, not just on cluster teardown. hostPath is unmanaged by Kubernetes GC,
    // so it survives namespace deletion; it's shared across every vLLM deployment on the node
    // deliberately, since HF's own cache layout (models--org--name) already namespaces by
    // model and re-downloading a model every redeploy is exactly what this is meant to avoid.
    // On the native-k3s management cluster this is real host disk outside the k3s data-dir
    // `cluster.sh reset` wipes; on k3d it's bind-mounted from the host by
    // InfrastructureService.createLocalCluster (see VLLM_CACHE_HOST_DIR).
    const cacheHostPath = config.cachePvc
      ? (config.cachePvc.startsWith('/') ? config.cachePvc : `/var/lib/rancher/${config.cachePvc}`)
      : "/var/lib/rancher/vllm-model-cache";
    const shmSize = config.shmSize || "2Gi";
    const cpuLimit = config.cpuLimit || "10";
    const memoryLimit = config.memoryLimit || "20G";

    const serviceType = config.serviceType || (process.env.SELF_MANAGED_K8S === "true" ? "NodePort" : "LoadBalancer");

    const imageTag = config.imageTag && config.imageTag !== 'latest' ? config.imageTag : "v0.7.2";
    const imageName = gpuVendor === 'amd'
      ? `vllm/vllm-openai-rocm:${imageTag}`
      : `vllm/vllm-openai:${imageTag}`;

    const gpuResourceKey = gpuVendor === 'amd' ? 'amd.com/gpu' : 'nvidia.com/gpu';
    const gpuResources = (gpuCount > 0 && device !== 'cpu') ? { [gpuResourceKey]: gpuCount } : {};

    // Requesting N GPUs (nvidia.com/gpu resource, below) only reserves them — it doesn't tell
    // vLLM to actually use more than one. Without --tensor-parallel-size, vLLM defaults to 1 and
    // silently uses only the first visible GPU, leaving the rest reserved-but-idle. That's why a
    // 2-GPU pod can still be memory-constrained: it was only ever getting one GPU's VRAM for
    // weights + KV cache, not the combined total actually requested.
    const extraArgs = config.extraArgs || [];
    const serveArgs = [
      "vllm serve",
      modelName,
      "--trust-remote-code",
      "--enable-chunked-prefill",
      `--device ${device}`,
      ...(gpuCount > 1 ? [`--tensor-parallel-size ${gpuCount}`] : []),
      ...(config.maxModelLen !== undefined ? [`--max-model-len ${config.maxModelLen}`] : []),
      ...(config.gpuMemUtil !== undefined ? [`--gpu-memory-utilization ${config.gpuMemUtil}`] : []),
      // --tool-call-parser is required by vLLM whenever --enable-auto-tool-choice is passed —
      // gating both on the parser being set avoids ever sending the flag alone and getting
      // vLLM's own startup error ("auto tool choice requires --tool-call-parser to be set").
      ...(config.toolCallingEnabled && config.toolCallParser ? ['--enable-auto-tool-choice', `--tool-call-parser ${config.toolCallParser}`] : []),
      ...(config.servedModelName ? [`--served-model-name ${config.servedModelName}`] : []),
      ...(config.maxNumSeqs !== undefined ? [`--max-num-seqs ${config.maxNumSeqs}`] : []),
      ...(config.dtype ? [`--dtype ${config.dtype}`] : []),
      ...(config.enablePrefixCaching ? ['--enable-prefix-caching'] : []),
      ...extraArgs,
    ].join(" ");

    const ns = new Namespace(this, "ns", {
      metadata: {
        name: namespaceName,
      },
    });

    if (hfToken) {
      new Secret(this, "hf-token-secret", {
        metadata: {
          name: "hf-token-secret",
          namespace: ns.metadata.name,
        },
        // `data`, not `stringData` — the Terraform kubernetes provider has no stringData field, so
        // that block was silently dropped and this Secret was created EMPTY. The provider
        // base64-encodes `data` values itself, so plaintext here is correct.
        data: {
          token: hfToken,
        },
      });
    }

    const sanitizedName = namespaceName.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

    const containerSpec: any = {
      name: "vllm",
      image: imageName,
      command: ["/bin/sh", "-c"],
      args: [serveArgs],
      env: [
        {
          name: "HF_HOME",
          value: "/root/.cache/huggingface",
        },
        {
          name: "VLLM_MODEL",
          value: modelName,
        },
        {
          name: "VLLM_TARGET_DEVICE",
          value: device,
        },
        {
          name: "HF_TOKEN",
          value: hfToken,
        },
        {
          name: "HUGGING_FACE_HUB_TOKEN",
          value: hfToken,
        },
      ],
      port: [
        {
          containerPort: 8000,
        },
      ],
      resources: {
        limits: {
          cpu: cpuLimit,
          memory: memoryLimit,
          ...gpuResources,
        },
        requests: {
          cpu: "2",
          memory: "6G",
          ...gpuResources,
        },
      },
      volumeMount: [
        {
          name: "model-cache",
          mountPath: "/root/.cache/huggingface",
        },
        {
          name: "shm",
          mountPath: "/dev/shm",
        },
      ],
      // vLLM's /health doesn't return 200 until the model is fully downloaded AND loaded into
      // memory — for any real model that's minutes, not the ~90s the old liveness probe
      // actually allowed (initialDelaySeconds: 60 + default failureThreshold: 3 * periodSeconds:
      // 10 = 90s). kubelet was killing and restarting the container before the model ever
      // finished downloading — a genuine crash-restart loop, not a Terraform/CDKTF-level issue.
      // startupProbe is Kubernetes' purpose-built fix for exactly this: liveness/readiness are
      // suspended entirely until it succeeds once, so a slow first start doesn't get mistaken
      // for a hung container, while liveness/readiness stay fast at detecting a REAL crash once
      // the server is actually up. 30 min window comfortably covers model download+load and
      // stays well under the deploy activity's 80 min Temporal timeout.
      startupProbe: {
        httpGet: {
          path: "/health",
          port: 8000,
        },
        initialDelaySeconds: 10,
        timeoutSeconds: 10,
        periodSeconds: 10,
        failureThreshold: 359, // 10 + 359*10 = 3600s (~60min) total allowance
      },
      // timeoutSeconds defaults to 1s when unset — far too tight for a GPU inference server
      // that might be mid-generation on a real request when the probe fires. Same fix and same
      // reasoning as tabbyapi.ts's identical probes — see that file's comment for the live
      // failure this caused (a healthy pod killed mid-stream because /health itself timed out,
      // not a crash) and for why liveness is deliberately far more tolerant than readiness here
      // (killing a busy-but-alive pod is destructive; vLLM is single-process for the same VRAM
      // reason TabbyAPI is, so /health can't be made to respond instantly during generation).
      livenessProbe: {
        httpGet: {
          path: "/health",
          port: 8000,
        },
        timeoutSeconds: 30,
        periodSeconds: 15,
        failureThreshold: 8,
      },
      readinessProbe: {
        httpGet: {
          path: "/health",
          port: 8000,
        },
        timeoutSeconds: 15,
        periodSeconds: 10,
        failureThreshold: 3,
      },
    };

    // AMD-specific security context
    if (gpuVendor === 'amd') {
      containerSpec.securityContext = {
        seccompProfile: {
          type: "Unconfined",
        },
        runAsGroup: 44,
        capabilities: {
          add: ["SYS_PTRACE"],
        },
      };
    }

    const volumes: any[] = [
      {
        name: "model-cache",
        hostPath: {
          path: cacheHostPath,
          type: "DirectoryOrCreate",
        },
      },
      {
        name: "shm",
        emptyDir: {
          medium: "Memory",
          sizeLimit: shmSize,
        },
      },
    ];

    const podSpec: any = {
      container: [containerSpec],
      volume: volumes,
    };

    // Point at the containerd runtime k3s auto-registers when nvidia-container-runtime is
    // present on the host (see InfrastructureService.installGpuDevicePlugin, which applies the
    // matching RuntimeClass) — this is what actually gets the container real GPU device access;
    // requesting nvidia.com/gpu resources alone only affects scheduling, not runtime injection.
    if (gpuVendor === 'nvidia' && gpuCount > 0 && device !== 'cpu') {
      podSpec.runtimeClassName = "nvidia";
    }

    // AMD-specific pod settings
    if (gpuVendor === 'amd') {
      podSpec.hostNetwork = true;
      podSpec.hostIPC = true;
    }

    new Deployment(this, "vllm-deployment", {
      metadata: {
        name: `${sanitizedName}-vllm`,
        namespace: ns.metadata.name,
        labels: {
          app: `${sanitizedName}-vllm`,
        },
      },
      spec: {
        replicas: "1",
        // Default RollingUpdate tries to bring the new pod up BEFORE tearing down the old one
        // — with only 1 replica and a GPU request that can saturate the node (confirmed live:
        // an old pod holding both GPUs blocked a new 1-GPU pod from ever scheduling,
        // "Insufficient nvidia.com/gpu", permanently stuck Pending). Recreate tears the old pod
        // down first, releasing its GPU(s), before the new one is scheduled — correct for any
        // single-replica GPU workload regardless of whether GPU count changed between applies.
        strategy: gpuCount > 0 && device !== 'cpu' ? { type: "Recreate" } : undefined,
        // Kubernetes' own stall detector, independent of (and enforced before) the `timeouts`
        // block below — defaults to 600s, and the API server marks the Deployment
        // ProgressDeadlineExceeded at that point regardless of how patient Terraform is willing
        // to be (confirmed live on tabbyapi.ts's identical setup: a rollout still mid-download at
        // 10m1s failed here even though `timeouts.create` below had ~20 minutes left). Matches
        // the startupProbe window above so neither cuts the other off first.
        progressDeadlineSeconds: 3630,
        selector: {
          matchLabels: {
            app: `${sanitizedName}-vllm`,
          },
        },
        template: {
          metadata: {
            labels: {
              app: `${sanitizedName}-vllm`,
            },
          },
          spec: podSpec,
        },
      },
      // Terraform's kubernetes_deployment resource waits for the rollout to reach Available
      // before considering `cdktf deploy` successful (wait_for_rollout defaults to true, which
      // we want to keep — it's what makes "deployed" mean "actually serving", not just
      // "manifest applied"). Its own default create timeout is much shorter than a model
      // download can take; extend it to match the startupProbe window above.
      timeouts: {
        create: "65m",
        update: "65m",
      },
    });

    new Service(this, "vllm-service", {
      metadata: {
        name: `${sanitizedName}-vllm`,
        namespace: ns.metadata.name,
      },
      spec: {
        type: serviceType,
        selector: {
          app: `${sanitizedName}-vllm`,
        },
        port: [
          {
            port: 8000,
            targetPort: "8000",
          },
        ],
      },
      // waitForLoadBalancer, not waitUntilReady — the latter is not a ServiceConfig field and was
      // silently ignored, so this Service was waiting for an LB that never arrives on k3s.
      waitForLoadBalancer: false,
    });

    createAppIngress(this, "ingress", {
      namespace: namespaceName,
      serviceName: `${sanitizedName}-vllm`,
      servicePort: 8000,
      hostname: `${namespaceName}.apps.local`,
    });

    createAppProbe(this, "probe", {
      namespace: namespaceName,
      serviceName: `${sanitizedName}-vllm`,
      servicePort: 8000,
    });

    // vLLM's OpenAI-compatible server exposes a Prometheus /metrics endpoint on the same port as
    // its API — a well-documented, stable core feature (num_requests_running,
    // time_to_first_token, gpu_cache_usage_perc, etc.), unlike TabbyAPI (deliberately NOT given
    // an equivalent ServiceMonitor — confirmed by reading its actual FastAPI route registration
    // in endpoints/server.py: only OAI/Kobold/Core routers, no metrics route exists at all).
    // NOT independently live-verified against a real running pod the way everything else in this
    // observability effort was: vLLM needs a GPU and a real model download to actually start,
    // and this platform doesn't cache a small enough model to make that a cheap check. Spot-check
    // `curl http://<pod>:8000/metrics` next time a real vLLM deployment runs.
    new Manifest(this, "servicemonitor", {
      manifest: {
        apiVersion: "monitoring.coreos.com/v1",
        kind: "ServiceMonitor",
        metadata: {
          name: `${sanitizedName}-vllm`,
          namespace: namespaceName,
          labels: {
            release: "kube-prometheus-stack",
          },
        },
        spec: {
          selector: {
            matchLabels: {
              app: `${sanitizedName}-vllm`,
            },
          },
          endpoints: [
            // targetPort (numeric), not port (name) — the vLLM Service above never names its
            // port, so there's nothing for ServiceMonitor's name-based `port` field to match.
            {
              targetPort: 8000,
              path: "/metrics",
            },
          ],
        },
      },
    });
  }
}
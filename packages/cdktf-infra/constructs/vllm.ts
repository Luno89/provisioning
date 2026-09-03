import * as fs from "fs";
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
    const cacheHostPath = config.cachePvc
      ? (config.cachePvc.startsWith('/') ? config.cachePvc : `/var/lib/rancher/${config.cachePvc}`)
      : "/var/lib/rancher/vllm-model-cache";

    const modelFolderName = modelName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const preDownloadedDir = `${cacheHostPath}/${modelFolderName}`;
    const isPreDownloaded = fs.existsSync(`${preDownloadedDir}.complete`) && fs.existsSync(`${preDownloadedDir}/config.json`);
    const modelArg = isPreDownloaded ? `/root/.cache/huggingface/${modelFolderName}` : modelName;

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

    const extraArgs = config.extraArgs || [];
    const servedModelName = config.servedModelName || (isPreDownloaded ? modelName : undefined);
    const serveArgs = [
      "vllm serve",
      modelArg,
      "--trust-remote-code",
      "--enable-chunked-prefill",
      `--device ${device}`,
      ...(gpuCount > 1 ? [`--tensor-parallel-size ${gpuCount}`] : []),
      ...(config.maxModelLen !== undefined ? [`--max-model-len ${config.maxModelLen}`] : []),
      ...(config.gpuMemUtil !== undefined ? [`--gpu-memory-utilization ${config.gpuMemUtil}`] : []),
      ...(config.toolCallingEnabled && config.toolCallParser ? ['--enable-auto-tool-choice', `--tool-call-parser ${config.toolCallParser}`] : []),
      ...(servedModelName ? [`--served-model-name ${servedModelName}`] : []),
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

    if (gpuVendor === 'nvidia' && gpuCount > 0 && device !== 'cpu') {
      podSpec.runtimeClassName = "nvidia";
    }

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
        strategy: gpuCount > 0 && device !== 'cpu' ? { type: "Recreate" } : undefined,
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
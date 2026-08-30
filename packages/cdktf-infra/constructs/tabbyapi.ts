import { Construct } from "constructs";
import { Namespace } from "../.gen/providers/kubernetes/namespace/index.js";
import { Deployment } from "../.gen/providers/kubernetes/deployment/index.js";
import { Service } from "../.gen/providers/kubernetes/service/index.js";
import { createAppIngress } from "../lib/app-ingress.js";
import { createAppProbe } from "../lib/app-probe.js";
import { isValidImageTag } from "../lib/image-tag.js";

export interface TabbyApiConfig {
  readonly namespace?: string;
  readonly model?: string;
  readonly revision?: string;
  readonly gpuCount?: number;
  // Real byte count from HuggingFace (see DeployAppActivity.ts) — when present, this replaces
  // the repo-name regex guess below for shm/memory sizing entirely, since it's just correct
  // instead of an estimate.
  readonly modelSizeBytes?: number;
  readonly hfToken?: string;
  readonly cachePvc?: string;
  readonly serviceType?: string;
  readonly imageTag?: string;
  readonly shmSize?: string;
  readonly cpuLimit?: string;
  readonly memoryLimit?: string;
  readonly cacheMode?: string;
  readonly maxSeqLen?: number;
  readonly maxBatchSize?: number;
  readonly reasoning?: boolean;
  readonly toolFormat?: string;
  readonly inlineModelLoading?: boolean;
  readonly disableAuth?: boolean;
  readonly extraEnv?: string;
}

export class TabbyApiApp extends Construct {
  constructor(scope: Construct, id: string, config: TabbyApiConfig = {}) {
    super(scope, id);

    const namespaceName = config.namespace || "tabbyapi";
    // exllamav3 (TabbyAPI's only backend) has no CPU fallback and no ROCm build — unlike
    // vllm.ts there's no gpuVendor/device axis to plumb through here, it's CUDA-only.
    const modelRepo = config.model || "bartowski/Llama-3.2-3B-Instruct-exl2";
    const revision = config.revision;
    const gpuCount = config.gpuCount !== undefined ? config.gpuCount : 1;
    const hfToken = config.hfToken || process.env.HF_TOKEN || process.env.TABBYAPI_HF_TOKEN || "";
    // hostPath, not a PVC — same reasoning as vllm.ts's cacheHostPath: survives app
    // destroy/redeploy (unlike a namespace-scoped PVC, which local-path-provisioner's default
    // reclaimPolicy would delete), shared across every TabbyAPI deployment on the node since a
    // model downloaded once shouldn't be re-fetched per deployment.
    const cacheHostPath = config.cachePvc
      ? (config.cachePvc.startsWith('/') ? config.cachePvc : `/var/lib/rancher/${config.cachePvc}`)
      : "/var/lib/rancher/tabbyapi-model-cache";
    // exllamav3's tensor-parallel loading stages weights between GPU worker processes through
    // /dev/shm (Python multiprocessing shared memory) — a flat "4Gi regardless of model" was
    // nowhere near enough for a 27B model. Confirmed live: writes past the tmpfs limit don't
    // raise a catchable Python exception, they SIGBUS the whole process (exit code 135), which is
    // why this failed with no traceback, just "Loading with tensor parallel" followed by a
    // resource_tracker warning and a silent restart.
    //
    // Sized from the actual model rather than a flat guess, preferring real bytes (from
    // HuggingFace's file-tree API — see DeployAppActivity.ts) over a regex estimate parsed from
    // the repo name ("27B", "8B", ...) and revision ("5.00bpw"). Either way the total is divided
    // by gpuCount: tensor parallelism shards the model across GPU worker processes by design, so
    // each one's shm footprint should track its own shard, not the whole model.
    const paramsBMatch = modelRepo.match(/(\d+(?:\.\d+)?)[Bb](?:[^a-zA-Z]|$)/);
    const bpwMatch = revision?.match(/(\d+(?:\.\d+)?)\s*bpw/i);
    const estimatedShardGiB = config.modelSizeBytes
      // Real size already reflects tokenizer/config file overhead and actual quantization, so
      // it only needs a modest margin for shm staging overhead, not the bit-math estimate's
      // wider 1.3x fudge factor.
      ? (config.modelSizeBytes / 1e9 / Math.max(gpuCount, 1)) * 1.15
      : paramsBMatch
      // No bpw in the revision (or no revision at all) still means *a* quant was picked — 6.0 is
      // a reasonable mid-range assumption for "unknown" rather than under- or over-shooting
      // wildly. Verified live: a Qwen3.6-27B-exl3 5.00bpw checkout is 18.6GB on disk against a
      // raw 27*5/8=16.9GB bit-math estimate — the ~18% gap is why this branch uses a wider 1.3x
      // margin than the real-bytes branch above.
      ? (parseFloat(paramsBMatch[1]) * (bpwMatch ? parseFloat(bpwMatch[1]) : 6.0) / 8 / Math.max(gpuCount, 1)) * 1.3
      : undefined;
    // Falls back to a flat 12Gi only when neither the real size nor the repo-name regex is
    // available — set shmSize explicitly for anything unusual this heuristic gets wrong.
    const shmSize = config.shmSize || (estimatedShardGiB ? `${Math.max(4, Math.ceil(estimatedShardGiB))}Gi` : "12Gi");
    const cpuLimit = config.cpuLimit || "10";
    // Floats with shmSize (+12G for the process itself: Python/CUDA host-side overhead, request
    // buffers, and KV cache staging) with a seqLen factor for high context windows (>32k/64k)
    // rather than a tight 20G limit that long contexts or large models easily exceed (OOMKill).
    const maxSeqLen = config.maxSeqLen !== undefined ? config.maxSeqLen : 262144;
    const seqLenFactor = maxSeqLen > 65536 ? 1.5 : (maxSeqLen > 32768 ? 1.25 : 1.0);
    const memoryLimit = config.memoryLimit || (estimatedShardGiB ? `${Math.max(32, Math.ceil((estimatedShardGiB * seqLenFactor) + 12))}G` : "32G");

    const serviceType = config.serviceType || (process.env.SELF_MANAGED_K8S === "true" ? "NodePort" : "LoadBalancer");

    const imageTag = isValidImageTag(config.imageTag) ? config.imageTag : 'latest';
    const imageName = `ghcr.io/theroyallab/tabbyapi:${imageTag}`;

    const gpuResources = gpuCount > 0 ? { 'nvidia.com/gpu': gpuCount } : {};

    // EXL2/EXL3 quants are frequently distributed as multiple bpw (bits-per-weight) branches of
    // the SAME repo rather than separate repos, so the cache folder name has to fold in the
    // revision too — otherwise two different quant sizes of one model would collide on disk.
    const folderName = `${modelRepo}${revision ? `--${revision}` : ''}`
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

    // TabbyAPI has no "vllm serve"-style single command that downloads-then-serves — `main.py
    // download` and running the server are two separate invocations (see main.py/args.py). We
    // stitch them into one container command instead of using an initContainer so the shared
    // hostPath cache and the HF_TOKEN env only need to be wired up once. A `.complete` marker
    // (rather than just checking the model dir exists) means a pod killed mid-download leaves
    // no half-written directory that a restart would mistake for a finished one — the old dir is
    // wiped and re-downloaded instead of the server starting against truncated weights.
    const modelDir = `/app/models/${folderName}`;
    const downloadCmd = [
      `if [ ! -f "${modelDir}.complete" ]; then`,
      `  rm -rf "${modelDir}";`,
      [
        `python3 main.py download ${modelRepo}`,
        `--folder-name ${folderName}`,
        ...(revision ? [`--revision ${revision}`] : []),
        ...(hfToken ? [`--token "$HF_TOKEN"`] : []),
      ].join(' ') + `;`,
      // TabbyAPI's own downloader (common/actions.py download_action) catches every exception —
      // network errors, a bad --revision, a gated repo with no/wrong token, rate limits — logs
      // it, and returns normally. `main.py download` always exits 0 regardless, so the `&&` a
      // version of this once relied on could mark the cache complete for a directory that was
      // never actually written (confirmed live: this is exactly what happened, silently, and
      // then crashed the server on next boot with a config.json FileNotFoundError). config.json
      // is present in every EXL2/EXL3 repo and is the same file the server itself requires to
      // boot, so its presence is a real proxy for "download actually succeeded" that doesn't
      // trust the process exit code at all.
      `if [ -f "${modelDir}/config.json" ]; then touch "${modelDir}.complete"; else echo "TabbyAPI's downloader did not produce ${modelDir}/config.json — see the error logged above (bad --revision, missing/invalid HF token for a gated repo, or a network failure are the usual causes). Cache NOT marked complete, will retry on next start." >&2; exit 1; fi`,
      `fi`,
    ].join(' ');

    const ns = new Namespace(this, "ns", {
      metadata: {
        name: namespaceName,
      },
    });

    const sanitizedName = namespaceName.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

    const envVars: { name: string; value: string }[] = [
      { name: "TABBY_NETWORK_HOST", value: "0.0.0.0" },
      { name: "TABBY_NETWORK_PORT", value: "5000" },
      // Upstream defaults disable_auth to false (an admin/api key is required and
      // auto-generated into api_tokens.yml on first boot) — our container filesystem is
      // ephemeral, so that generated key would be unrecoverable after a restart. Disabling
      // auth by default matches vllm.ts's own zero-auth posture and keeps Open WebUI wiring
      // (OPENAI_API_BASE_URL) working with no key to configure.
      { name: "TABBY_NETWORK_DISABLE_AUTH", value: config.disableAuth === false ? 'false' : 'true' },
      { name: "TABBY_MODEL_MODEL_DIR", value: "/app/models" },
      { name: "TABBY_MODEL_MODEL_NAME", value: folderName },
      { name: "TABBY_MODEL_INLINE_MODEL_LOADING", value: config.inlineModelLoading ? 'true' : 'false' },
      // Tensor parallelism claims the GPUs reserved below; single-GPU deployments leave this
      // unset so exllamav3 doesn't attempt multi-GPU coordination it doesn't need.
      ...(gpuCount > 1 ? [{ name: "TABBY_MODEL_TENSOR_PARALLEL", value: "true" }] : []),
      ...(config.cacheMode ? [{ name: "TABBY_MODEL_CACHE_MODE", value: config.cacheMode }] : []),
      ...(config.maxSeqLen !== undefined ? [{ name: "TABBY_MODEL_MAX_SEQ_LEN", value: String(config.maxSeqLen) }] : []),
      ...(config.maxBatchSize !== undefined ? [{ name: "TABBY_MODEL_MAX_BATCH_SIZE", value: String(config.maxBatchSize) }] : []),
      ...(config.reasoning ? [{ name: "TABBY_MODEL_REASONING", value: "true" }] : []),
      // NOTE: TabbyAPI's TABBY_<SECTION>_<FIELD> env mechanism (common/tabby_config.py
      // _from_environment) only ever reads a plain string per var and hands it straight to
      // pydantic — there's no JSON/list parsing anywhere in that path. Any config.yml field
      // typed as a list (use_as_default, dummy_model_names, api_servers, gpu_split, loras, ...)
      // CANNOT be set through an env var; pydantic rejects a string where it expects a list
      // (confirmed live: config.model.use_as_default = "[...]" throws a list_type
      // ValidationError at boot). We deliberately don't set use_as_default here as a result —
      // reasoning/tool_format still apply to the model loaded at startup (the only model this
      // construct ever loads), the only loss is that a manually inline-loaded model (see
      // inlineModelLoading) wouldn't auto-inherit them unless the load request passes them
      // explicitly.
      ...(config.toolFormat ? [{ name: "TABBY_MODEL_TOOL_FORMAT", value: config.toolFormat }] : []),
      ...(hfToken ? [{ name: "HF_TOKEN", value: hfToken }, { name: "HUGGING_FACE_HUB_TOKEN", value: hfToken }] : []),
    ];

    // extraEnv passthrough for the ~30 other config.yml fields not worth a dedicated UI field
    // each (chunk_size, rope_scale, draft_model.*, embeddings.*, ...) — same escape-hatch role
    // as vllm.ts's extraArgs, one "KEY=VALUE" per line.
    if (config.extraEnv) {
      for (const line of config.extraEnv.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        envVars.push({ name: trimmed.slice(0, eq).trim(), value: trimmed.slice(eq + 1).trim() });
      }
    }

    // ghcr.io/theroyallab/tabbyapi ships without python3-dev, so Triton (used by the `fla`
    // flash-linear-attention library) can't JIT-compile its CUDA kernels — confirmed live: it
    // fails with "Python.h: No such file or directory" and silently falls back to plain CPU
    // execution for every `linear_attention` layer. That's not a minor perf hit: hybrid
    // architectures (e.g. Qwen3.5/3.6's repeating 3-linear/1-full layer pattern) spend the
    // majority of their forward pass in exactly those layers, making CPU fallback the difference
    // between usable and not. Installing the one missing package (confirmed live: fixes it
    // completely, no CPU-fallback warning survives) is cheap next to a multi-GB model
    // download/load and has to happen on every container start since it isn't baked into the
    // image. Non-fatal on failure — a model that's pure full_attention doesn't need this at all.
    const pythonDevInstallCmd = `(apt-get update -qq && apt-get install -y -qq python3-dev >/dev/null 2>&1) || echo "WARNING: could not install python3-dev — Triton/fla kernels will fall back to CPU, which is severe for hybrid linear-attention models" >&2`;

    const containerSpec: any = {
      name: "tabbyapi",
      image: imageName,
      command: ["/bin/sh", "-c"],
      // `fi` (ending the if-block above) must be followed by a command separator before the
      // next command — a bare space is a shell syntax error. `&&` doubles as that separator and
      // means a failed download (marker never touched) stops here instead of exec-ing the
      // server against a missing/partial model.
      args: [`${pythonDevInstallCmd} && ${downloadCmd} && exec python3 main.py --host 0.0.0.0`],
      env: envVars,
      port: [
        {
          containerPort: 5000,
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
          mountPath: "/app/models",
        },
        {
          name: "shm",
          mountPath: "/dev/shm",
        },
      ],
      // Same rationale as vllm.ts's startupProbe: a large model download + exllamav3 load can
      // comfortably take minutes, well past any liveness probe's default grace period. Suspend
      // liveness/readiness until this succeeds once so a slow first start isn't mistaken for a
      // hung container.
      startupProbe: {
        httpGet: {
          path: "/health",
          port: 5000,
        },
        initialDelaySeconds: 10,
        timeoutSeconds: 10,
        periodSeconds: 10,
        failureThreshold: 359, // 10 + 359*10 = 3600s (~60min) total allowance
      },
      // timeoutSeconds defaults to 1s when unset — far too tight for a GPU inference server.
      // Confirmed live: a pod mid-generation on a real streaming chat completion failed its
      // liveness probe with "context deadline exceeded" (the /health request itself timed out,
      // not a real crash) and got killed — cutting off the in-flight request with "ASGI callable
      // returned without completing response."
      //
      // TabbyAPI is single-process by design here — running multiple uvicorn workers would each
      // load a separate full copy of the model into VRAM, which the GPU budget doesn't have room
      // for — so /health shares the same event loop as generation and can't be made to respond
      // instantly while a request is in flight; that's not something fixable from the K8s side.
      // Liveness is deliberately much more tolerant than readiness as a result: killing the pod
      // is destructive (drops every in-flight request), so it should only fire for a genuinely
      // hung process, not a busy one. 30s timeout + 8 failures over a 15s period means ~135s of
      // sustained unresponsiveness before a kill — long enough to outlast any real generation,
      // long context prefill included, while still recovering a truly stuck pod within ~2min.
      livenessProbe: {
        httpGet: {
          path: "/health",
          port: 5000,
        },
        timeoutSeconds: 30,
        periodSeconds: 15,
        failureThreshold: 8,
      },
      // Readiness only gates traffic (doesn't kill anything) so it can afford to react faster —
      // though with replicas: 1 there's nowhere else for traffic to go anyway, so this mostly
      // just reflects "temporarily busy" accurately rather than changing behavior much.
      readinessProbe: {
        httpGet: {
          path: "/health",
          port: 5000,
        },
        timeoutSeconds: 15,
        periodSeconds: 10,
        failureThreshold: 3,
      },
    };

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

    // Same RuntimeClass wiring as vllm.ts — see InfrastructureService.installGpuDevicePlugin.
    if (gpuCount > 0) {
      podSpec.runtimeClassName = "nvidia";
    }

    new Deployment(this, "tabbyapi-deployment", {
      metadata: {
        name: `${sanitizedName}-tabbyapi`,
        namespace: ns.metadata.name,
        labels: {
          app: `${sanitizedName}-tabbyapi`,
        },
      },
      spec: {
        replicas: "1",
        // Same single-replica GPU-release reasoning as vllm.ts: tear the old pod down before
        // scheduling the new one so it isn't stuck Pending on GPUs the old pod still holds.
        strategy: gpuCount > 0 ? { type: "Recreate" } : undefined,
        // Kubernetes' own stall detector, independent of (and enforced before) the `timeouts`
        // block below — it defaults to 600s and the API server marks the Deployment
        // ProgressDeadlineExceeded at that point regardless of how patient Terraform is willing
        // to be. Confirmed live: a TabbyAPI rollout (apt-get install + a multi-GB model download
        // + GPU model load, all before the startupProbe can ever pass) blew past the 600s
        // default and failed here even though `timeouts.create` below still had time left — and
        // then even the first bumped value (30min) turned out not to be enough for a slow
        // download. Matches startupProbe's own ~60min allowance so neither cuts the other off
        // first; bump both together if 60min still isn't enough; they have to move as a pair.
        progressDeadlineSeconds: 3630,
        selector: {
          matchLabels: {
            app: `${sanitizedName}-tabbyapi`,
          },
        },
        template: {
          metadata: {
            labels: {
              app: `${sanitizedName}-tabbyapi`,
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

    new Service(this, "tabbyapi-service", {
      metadata: {
        name: `${sanitizedName}-tabbyapi`,
        namespace: ns.metadata.name,
      },
      spec: {
        type: serviceType,
        selector: {
          app: `${sanitizedName}-tabbyapi`,
        },
        port: [
          {
            port: 5000,
            targetPort: "5000",
          },
        ],
      },
      // waitForLoadBalancer, not waitUntilReady — see vllm.ts; the latter is not a ServiceConfig
      // field and was silently ignored.
      waitForLoadBalancer: false,
    });

    createAppIngress(this, "ingress", {
      namespace: namespaceName,
      serviceName: `${sanitizedName}-tabbyapi`,
      servicePort: 5000,
      hostname: `${namespaceName}.apps.local`,
    });

    createAppProbe(this, "probe", {
      namespace: namespaceName,
      serviceName: `${sanitizedName}-tabbyapi`,
      servicePort: 5000,
    });
  }
}

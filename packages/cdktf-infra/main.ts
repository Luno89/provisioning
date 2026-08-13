import { App, TerraformStack } from "cdktf";
import { Construct } from "constructs";
import { BaseCluster } from "./constructs/cluster.js";
import { OdooApp } from "./constructs/odoo.js";
import { OdooNativeApp } from "./constructs/odoo-native.js";
import { WordPressApp } from "./constructs/wordpress.js";
import { WordPressNativeApp } from "./constructs/wordpress-native.js";
import { NextcloudApp } from "./constructs/nextcloud.js";
import { NextcloudNativeApp } from "./constructs/nextcloud-native.js";
import { AudiobookshelfApp } from "./constructs/audiobookshelf.js";
import { AudiobookshelfNativeApp } from "./constructs/audiobookshelf-native.js";
import { PrometheusApp } from "./constructs/prometheus.js";
import { TemporalApp } from "./constructs/temporal.js";
import { TraefikApp } from "./constructs/traefik.js";
import { VllmApp } from "./constructs/vllm.js";
import { TabbyApiApp } from "./constructs/tabbyapi.js";
import { OpenWebUiApp } from "./constructs/open-webui.js";
import { HermesAgentApp } from "./constructs/hermes-agent.js";
import { GitappApp } from "./constructs/gitapp.js";
import { PalworldApp } from "./constructs/palworld.js";
import { JellyfinNativeApp } from "./constructs/jellyfin-native.js";
import { PlexNativeApp } from "./constructs/plex-native.js";
import { NavidromeNativeApp } from "./constructs/navidrome-native.js";
import { KavitaNativeApp } from "./constructs/kavita-native.js";
import { ImmichNativeApp } from "./constructs/immich-native.js";
import { PapraNativeApp } from "./constructs/papra-native.js";
import { HomeassistantNativeApp } from "./constructs/homeassistant-native.js";
import { SearxngNativeApp } from "./constructs/searxng-native.js";
import { Crawl4aiNativeApp } from "./constructs/crawl4ai-native.js";
import { MinioNativeApp } from "./constructs/minio-native.js";
import { QdrantNativeApp } from "./constructs/qdrant-native.js";
import { QuickwitNativeApp } from "./constructs/quickwit-native.js";
import { TeiNativeApp } from "./constructs/tei-native.js";
import { MonitoringStack } from "./constructs/monitoring.js";
import { IngressStack } from "./constructs/ingress.js";
import { DashboardsStack } from "./constructs/dashboards.js";
import { BlackboxExporterStack } from "./constructs/blackbox-exporter.js";
import { AlertingStack } from "./constructs/alerting.js";
import { LoggingStack } from "./constructs/logging.js";
import { HetznerVmStack } from "./constructs/hetzner-vm.js";
import { K8sProviderService } from "./lib/k8s-provider-service.js";
import { type VpnConfig } from "./lib/vpn-service.js";

export interface ClusterStackConfig {
  environment: "local" | "k3d" | "aws" | "gcp" | "azure" | "do" | "remote" | "hetzner";
  name: string;
}

function initK8sProvider(scope: Construct, config: ClusterStackConfig): void {
  const isLocal = config.environment === "local" || config.environment === "k3d";
  const kubeconfig = process.env.KUBECONFIG_PATH || (isLocal ? "~/.kube/config" : `/tmp/kubeconfig-${config.name}`);
  const context = isLocal ? `k3d-${config.name}` : undefined;

  K8sProviderService.initialize(scope, {
    kubeconfigPath: kubeconfig,
    kubeconfigContext: context,
  });
}

/**
 * ClusterStack manages the infrastructure provisioning (e.g. k3d, EKS) plus the pieces every
 * downstream construct can depend on: the Prometheus Operator CRDs (via MonitoringStack's
 * kube-prometheus-stack release) and the "monitoring" namespace itself.
 */
class ClusterStack extends TerraformStack {
  constructor(scope: Construct, id: string, config: ClusterStackConfig) {
    super(scope, id);
    initK8sProvider(this, config);

    new BaseCluster(this, "cluster", {
      environment: config.environment,
      name: config.name,
    });

    // Ordering is load-bearing, not cosmetic: Traefik's chart renders a ServiceMonitor that needs
    // the monitoring.coreos.com/v1 CRDs kube-prometheus-stack installs. Terraform would otherwise
    // apply the two Helm releases in parallel and Traefik's render fails outright — see
    // IngressStack's constructor doc.
    const monitoring = new MonitoringStack(this, "monitoring", config.name);
    new IngressStack(this, "ingress", [monitoring.prometheusRelease]);
  }
}

/**
 * ObservabilityStack holds everything that can only be applied *after* ClusterStack has actually
 * finished — not just "after" in dependency-declaration terms, but after a real, separate
 * `terraform apply` has completed. Every resource here either creates something inside the
 * "monitoring" namespace (DashboardsStack's ConfigMaps, LoggingStack's NetworkPolicy) or is a
 * `kubernetes_manifest` CRD instance (AlertingStack's PrometheusRule) — and the Kubernetes
 * provider's `kubernetes_manifest` resource resolves the target CRD's schema (GVK) at *plan*
 * time, before anything in that same `terraform apply` has been created yet. `depends_on` /
 * CDKTF's `node.addDependency` only control *apply-time ordering* between resources already in
 * the same plan — they do nothing for a plan-time lookup against the live cluster's current (pre
 * -apply) state. Confirmed live: even with an explicit `node.addDependency(monitoring)`, applying
 * ClusterStack and this stack's resources together in one `cdktf deploy` still failed identically
 * — "no matches for kind PrometheusRule in group monitoring.coreos.com" — because at plan time,
 * within that single apply, the CRD genuinely didn't exist in the cluster yet. This only ever
 * worked in earlier testing because those runs happened against a cluster that already had the
 * CRDs installed from a prior, separate apply. Two real, sequential `cdktf deploy` invocations —
 * this stack applied only after ClusterStack's has fully completed — is the actual fix (see
 * ProvisionClusterActivity.ts / ensure-cluster-stack.ts, both updated to deploy this stack right
 * after ClusterStack).
 */
class ObservabilityStack extends TerraformStack {
  constructor(scope: Construct, id: string, config: ClusterStackConfig) {
    super(scope, id);
    initK8sProvider(this, config);

    // "monitoring" matches MonitoringStack's own hardcoded namespace name (ClusterStack, applied
    // first) — Grafana's dashboard sidecar watches ConfigMaps by label across all namespaces (see
    // dashboards.ts), so this doesn't strictly have to live in the same namespace, but keeping
    // platform-owned resources together avoids scattering them for no reason.
    new DashboardsStack(this, "dashboards", "monitoring");
    new BlackboxExporterStack(this, "blackbox-exporter");
    new AlertingStack(this, "alerting");
    new LoggingStack(this, "logging", config.name);
  }
}

/**
 * AppStack manages the deployment of applications on a provisioned cluster.
 */
class AppStack extends TerraformStack {
  constructor(scope: Construct, id: string) {
    super(scope, id);
    
    K8sProviderService.fromEnv(this);

    let strategy = process.env.DEPLOYMENT_STRATEGY || 'helm';
    const appType = process.env.APP_TYPE || 'odoo';
    if (appType === 'odoo') {
      strategy = 'native';
    }
    const deploymentName = process.env.DEPLOYMENT_NAME || 'app';

    const webRepo = process.env.WEB_IMAGE_REPO || process.env.ODOO_IMAGE_REPO;
    const webTag = process.env.WEB_IMAGE_TAG || process.env.ODOO_IMAGE_TAG;
    const dbRepo = process.env.DB_IMAGE_REPO || process.env.POSTGRES_IMAGE_REPO;
    const dbTag = process.env.DB_IMAGE_TAG || process.env.POSTGRES_IMAGE_TAG;

    const storageDb = process.env.STORAGE_DB;
    const storageWeb = process.env.STORAGE_WEB;
    const storageLibrary = process.env.STORAGE_LIBRARY;
    const storageConfig = process.env.STORAGE_CONFIG;
    const storageMetadata = process.env.STORAGE_METADATA;
    const storageServer = process.env.STORAGE_SERVER;
    const storageData = process.env.STORAGE_DATA;
    const storageCache = process.env.STORAGE_CACHE;
    const storageMedia = process.env.STORAGE_MEDIA;
    const storageMusic = process.env.STORAGE_MUSIC;
    const storageManga = process.env.STORAGE_MANGA;

    // Schema-driven settings for app types with too many options for individual env vars (game
    // servers: ~120 each). Built by lib/app-settings-schema.ts on the backend and passed as one
    // JSON blob, so adding a setting needs no change here at all.
    let appSettings: Record<string, string> = {};
    if (process.env.APP_SETTINGS_JSON) {
      try {
        appSettings = JSON.parse(process.env.APP_SETTINGS_JSON);
      } catch (err) {
        throw new Error(`APP_SETTINGS_JSON is not valid JSON: ${(err as Error).message}`);
      }
    }

    const vpnEnabled = process.env.VPN_ENABLED === 'true';
    const vpnProtocol = process.env.VPN_PROTOCOL as 'wireguard' | 'openvpn' | undefined;
    const vpnConfig = process.env.VPN_CONFIG;
    const vpnDedicatedIp = process.env.VPN_DEDICATED_IP;
    const vpnProps: VpnConfig = vpnEnabled ? { vpnEnabled, vpnProtocol: vpnProtocol || 'wireguard', vpnConfig, vpnDedicatedIp } : {};

    if (strategy === 'native') {
      if (appType === 'wordpress') {
        new WordPressNativeApp(this, "wordpress-native", {
          namespace: deploymentName,
          ...(webRepo ? { webRepo } : {}),
          ...(webTag ? { webTag } : {}),
          ...(dbRepo ? { dbRepo } : {}),
          ...(dbTag ? { dbTag } : {}),
          ...(storageDb ? { dbStorage: storageDb } : {}),
          ...vpnProps,
        });
      } else if (appType === 'nextcloud') {
        new NextcloudNativeApp(this, "nextcloud-native", {
          namespace: deploymentName,
          ...(webRepo ? { webRepo } : {}),
          ...(webTag ? { webTag } : {}),
          ...(dbRepo ? { dbRepo } : {}),
          ...(dbTag ? { dbTag } : {}),
          ...(storageDb ? { dbStorage: storageDb } : {}),
          ...vpnProps,
        });
      } else if (appType === 'audiobookshelf') {
        new AudiobookshelfNativeApp(this, "audiobookshelf-native", {
          namespace: deploymentName,
          ...(webRepo ? { webRepo } : {}),
          ...(webTag ? { webTag } : {}),
          ...(storageMetadata ? { metadataStorage: storageMetadata } : {}),
          ...(storageConfig ? { configStorage: storageConfig } : {}),
          ...(storageLibrary ? { libraryStorage: storageLibrary } : {}),
          ...vpnProps,
        });
      } else if (appType === 'vllm') {
        new VllmApp(this, "vllm-app", {
          namespace: deploymentName,
          model: process.env.VLLM_MODEL,
          gpuCount: parseInt(process.env.VLLM_GPU_COUNT || '1'),
          gpuVendor: process.env.VLLM_GPU_VENDOR as 'nvidia' | 'amd' || 'nvidia',
          device: process.env.VLLM_DEVICE,
          hfToken: process.env.HF_TOKEN || process.env.VLLM_HF_TOKEN,
          cachePvc: process.env.VLLM_CACHE_PVC,
          imageTag: process.env.VLLM_IMAGE_TAG || process.env.WEB_IMAGE_TAG || 'v0.7.2',
          shmSize: process.env.VLLM_SHM_SIZE,
          cpuLimit: process.env.VLLM_CPU_LIMIT,
          memoryLimit: process.env.VLLM_MEMORY_LIMIT,
          maxModelLen: process.env.VLLM_MAX_MODEL_LEN ? parseInt(process.env.VLLM_MAX_MODEL_LEN) : undefined,
          gpuMemUtil: process.env.VLLM_GPU_MEM_UTIL ? parseFloat(process.env.VLLM_GPU_MEM_UTIL) : undefined,
          extraArgs: process.env.VLLM_EXTRA_ARGS ? [process.env.VLLM_EXTRA_ARGS] : undefined,
          toolCallingEnabled: process.env.VLLM_TOOL_CALLING_ENABLED === 'true',
          toolCallParser: process.env.VLLM_TOOL_CALL_PARSER || undefined,
          servedModelName: process.env.VLLM_SERVED_MODEL_NAME || undefined,
          maxNumSeqs: process.env.VLLM_MAX_NUM_SEQS ? parseInt(process.env.VLLM_MAX_NUM_SEQS) : undefined,
          dtype: process.env.VLLM_DTYPE || undefined,
          enablePrefixCaching: process.env.VLLM_ENABLE_PREFIX_CACHING === 'true',
        });
      } else if (appType === 'tabbyapi') {
        new TabbyApiApp(this, "tabbyapi-app", {
          namespace: deploymentName,
          model: process.env.TABBYAPI_MODEL,
          revision: process.env.TABBYAPI_REVISION || undefined,
          gpuCount: parseInt(process.env.TABBYAPI_GPU_COUNT || '1'),
          modelSizeBytes: process.env.TABBYAPI_MODEL_SIZE_BYTES ? parseInt(process.env.TABBYAPI_MODEL_SIZE_BYTES) : undefined,
          hfToken: process.env.HF_TOKEN || process.env.TABBYAPI_HF_TOKEN,
          cachePvc: process.env.TABBYAPI_CACHE_PVC,
          imageTag: process.env.TABBYAPI_IMAGE_TAG || 'latest',
          shmSize: process.env.TABBYAPI_SHM_SIZE,
          cpuLimit: process.env.TABBYAPI_CPU_LIMIT,
          memoryLimit: process.env.TABBYAPI_MEMORY_LIMIT,
          cacheMode: process.env.TABBYAPI_CACHE_MODE || undefined,
          maxSeqLen: process.env.TABBYAPI_MAX_SEQ_LEN ? parseInt(process.env.TABBYAPI_MAX_SEQ_LEN) : undefined,
          maxBatchSize: process.env.TABBYAPI_MAX_BATCH_SIZE ? parseInt(process.env.TABBYAPI_MAX_BATCH_SIZE) : undefined,
          reasoning: process.env.TABBYAPI_REASONING === 'true',
          toolFormat: process.env.TABBYAPI_TOOL_FORMAT || undefined,
          inlineModelLoading: process.env.TABBYAPI_INLINE_MODEL_LOADING === 'true',
          disableAuth: process.env.TABBYAPI_DISABLE_AUTH !== 'false',
          extraEnv: process.env.TABBYAPI_EXTRA_ENV || undefined,
        });
      } else if (appType === 'openwebui') {
        new OpenWebUiApp(this, "open-webui-app", {
          namespace: deploymentName,
          ...(webRepo ? { webRepo } : {}),
          ...(webTag ? { webTag } : {}),
          ...(process.env.OPENAI_API_BASE_URL ? { openaiApiBaseUrl: process.env.OPENAI_API_BASE_URL } : {}),
          ...(storageDb ? { storage: storageDb } : {}),
          ...(process.env.WEBUI_ENABLE_WEB_SEARCH === 'false' ? { enableWebSearch: false } : {}),
          ...(process.env.WEBUI_WEB_SEARCH_ENGINE ? { webSearchEngine: process.env.WEBUI_WEB_SEARCH_ENGINE } : {}),
          ...(process.env.WEBUI_WEB_SEARCH_API_KEY ? { webSearchApiKey: process.env.WEBUI_WEB_SEARCH_API_KEY } : {}),
        });
      } else if (appType === 'hermes') {
        new HermesAgentApp(this, "hermes-app", {
          namespace: deploymentName,
          ...(webRepo ? { webRepo } : {}),
          ...(webTag ? { webTag } : {}),
          ...(process.env.OPENAI_API_BASE_URL ? { openaiApiBaseUrl: process.env.OPENAI_API_BASE_URL } : {}),
          ...(storageDb ? { storage: storageDb } : {}),
        });
      } else if (appType === 'palworld') {
        new PalworldApp(this, "palworld-app", {
          namespace: deploymentName,
          settings: appSettings,
          ...(webRepo ? { webRepo } : {}),
          ...(webTag ? { webTag } : {}),
          ...(storageData ? { storage: storageData } : {}),
        });
      } else if (appType === 'gitapp') {
        // Image comes from a CI pipeline run (see RunPipelineActivity/GiteaService), always
        // resolved before this stack applies — webRepo/webTag are required, not optional
        // fallbacks like every other app type here.
        if (!webRepo || !webTag) {
          throw new Error('gitapp requires WEB_IMAGE_REPO and WEB_IMAGE_TAG (set from the promoted pipeline run\'s image tag)');
        }
        new GitappApp(this, "gitapp-app", {
          namespace: deploymentName,
          webRepo,
          webTag,
          ...(process.env.GITAPP_CONTAINER_PORT ? { containerPort: parseInt(process.env.GITAPP_CONTAINER_PORT) } : {}),
          ...(storageWeb ? { storage: storageWeb } : {}),
        });
      } else if (appType === 'jellyfin') {
        new JellyfinNativeApp(this, "jellyfin-native", {
          namespace: deploymentName,
          ...(webRepo ? { webRepo } : {}),
          ...(webTag ? { webTag } : {}),
          ...(storageConfig ? { configStorage: storageConfig } : {}),
          ...(storageCache ? { cacheStorage: storageCache } : {}),
          ...(storageMedia ? { mediaStorage: storageMedia } : {}),
          ...vpnProps,
        });
      } else if (appType === 'plex') {
        new PlexNativeApp(this, "plex-native", {
          namespace: deploymentName,
          ...(webRepo ? { webRepo } : {}),
          ...(webTag ? { webTag } : {}),
          ...(storageConfig ? { configStorage: storageConfig } : {}),
          ...(storageMedia ? { mediaStorage: storageMedia } : {}),
          ...vpnProps,
        });
      } else if (appType === 'navidrome') {
        new NavidromeNativeApp(this, "navidrome-native", {
          namespace: deploymentName,
          ...(webRepo ? { webRepo } : {}),
          ...(webTag ? { webTag } : {}),
          ...(storageData ? { dataStorage: storageData } : {}),
          ...(storageMusic ? { musicStorage: storageMusic } : {}),
          ...vpnProps,
        });
      } else if (appType === 'kavita') {
        new KavitaNativeApp(this, "kavita-native", {
          namespace: deploymentName,
          ...(webRepo ? { webRepo } : {}),
          ...(webTag ? { webTag } : {}),
          ...(storageConfig ? { configStorage: storageConfig } : {}),
          ...(storageManga ? { mangaStorage: storageManga } : {}),
          ...vpnProps,
        });
      } else if (appType === 'immich') {
        new ImmichNativeApp(this, "immich-native", {
          namespace: deploymentName,
          ...(webRepo ? { webRepo } : {}),
          ...(webTag ? { webTag } : {}),
          ...(storageLibrary ? { libraryStorage: storageLibrary } : {}),
          ...vpnProps,
        });
      } else if (appType === 'papra') {
        new PapraNativeApp(this, "papra-native", {
          namespace: deploymentName,
          ...(webRepo ? { webRepo } : {}),
          ...(webTag ? { webTag } : {}),
          ...(storageData ? { dataStorage: storageData } : {}),
          ...(storageMedia ? { mediaStorage: storageMedia } : {}),
          ...vpnProps,
        });
      } else if (appType === 'searxng') {
        new SearxngNativeApp(this, "searxng-native", {
          namespace: deploymentName,
          ...(webRepo ? { webRepo } : {}),
          ...(webTag ? { webTag } : {}),
          ...(process.env.SEARXNG_SECRET_KEY ? { secretKey: process.env.SEARXNG_SECRET_KEY } : {}),
          ...(process.env.SEARXNG_ENGINES ? { engines: process.env.SEARXNG_ENGINES } : {}),
          ...vpnProps,
        });
      } else if (appType === 'crawl4ai') {
        new Crawl4aiNativeApp(this, "crawl4ai-native", {
          namespace: deploymentName,
          ...(webRepo ? { webRepo } : {}),
          ...(webTag ? { webTag } : {}),
          ...(process.env.CRAWL4AI_API_TOKEN ? { apiToken: process.env.CRAWL4AI_API_TOKEN } : {}),
          ...(process.env.CRAWL4AI_MEMORY_LIMIT ? { memoryLimit: process.env.CRAWL4AI_MEMORY_LIMIT } : {}),
          ...(process.env.CRAWL4AI_SHM_SIZE ? { shmSize: process.env.CRAWL4AI_SHM_SIZE } : {}),
          ...vpnProps,
        });
      } else if (appType === 'minio') {
        new MinioNativeApp(this, "minio-native", {
          namespace: deploymentName,
          ...(webRepo ? { webRepo } : {}),
          ...(webTag ? { webTag } : {}),
          ...(process.env.MINIO_ROOT_USER ? { rootUser: process.env.MINIO_ROOT_USER } : {}),
          ...(process.env.MINIO_ROOT_PASSWORD ? { rootPassword: process.env.MINIO_ROOT_PASSWORD } : {}),
          ...(process.env.MINIO_STORAGE ? { storage: process.env.MINIO_STORAGE } : {}),
          ...vpnProps,
        });
      } else if (appType === 'qdrant') {
        new QdrantNativeApp(this, "qdrant-native", {
          namespace: deploymentName,
          ...(webRepo ? { webRepo } : {}),
          ...(webTag ? { webTag } : {}),
          ...(process.env.QDRANT_API_KEY ? { apiKey: process.env.QDRANT_API_KEY } : {}),
          ...(process.env.QDRANT_STORAGE ? { storage: process.env.QDRANT_STORAGE } : {}),
          ...(process.env.QDRANT_MEMORY_LIMIT ? { memoryLimit: process.env.QDRANT_MEMORY_LIMIT } : {}),
          ...vpnProps,
        });
      } else if (appType === 'quickwit') {
        new QuickwitNativeApp(this, "quickwit-native", {
          namespace: deploymentName,
          ...(webRepo ? { webRepo } : {}),
          ...(webTag ? { webTag } : {}),
          ...(process.env.QUICKWIT_S3_ENDPOINT ? { s3Endpoint: process.env.QUICKWIT_S3_ENDPOINT } : {}),
          ...(process.env.QUICKWIT_S3_ACCESS_KEY ? { s3AccessKey: process.env.QUICKWIT_S3_ACCESS_KEY } : {}),
          ...(process.env.QUICKWIT_S3_SECRET_KEY ? { s3SecretKey: process.env.QUICKWIT_S3_SECRET_KEY } : {}),
          ...(process.env.QUICKWIT_BUCKET ? { bucket: process.env.QUICKWIT_BUCKET } : {}),
          ...vpnProps,
        });
      } else if (appType === 'tei') {
        new TeiNativeApp(this, "tei-native", {
          namespace: deploymentName,
          ...(webRepo ? { webRepo } : {}),
          ...(webTag ? { webTag } : {}),
          ...(process.env.TEI_MODEL_ID ? { modelId: process.env.TEI_MODEL_ID } : {}),
          ...(process.env.TEI_USE_GPU === 'true' ? { useGpu: true } : {}),
          ...(process.env.TEI_MEMORY_LIMIT ? { memoryLimit: process.env.TEI_MEMORY_LIMIT } : {}),
          ...vpnProps,
        });
      } else if (appType === 'homeassistant') {
        new HomeassistantNativeApp(this, "homeassistant-native", {
          namespace: deploymentName,
          ...(webRepo ? { webRepo } : {}),
          ...(webTag ? { webTag } : {}),
          ...(storageConfig ? { configStorage: storageConfig } : {}),
          ...vpnProps,
        });
      } else {
        new OdooNativeApp(this, "odoo-native", {
          namespace: deploymentName,
          ...(webRepo ? { odooRepo: webRepo } : {}),
          ...(webTag ? { odooTag: webTag } : {}),
          ...(dbRepo ? { pgRepo: dbRepo } : {}),
          ...(dbTag ? { pgTag: dbTag } : {}),
          ...(process.env.ENABLED_MODULES ? { enabledModules: process.env.ENABLED_MODULES } : {}),
          ...(process.env.GIT_REPO_PATH ? { gitRepoPath: process.env.GIT_REPO_PATH } : {}),
          ...(storageDb ? { dbStorage: storageDb } : {}),
          ...vpnProps,
        });
      }
    } else {
      if (appType === 'wordpress') {
        new WordPressApp(this, "wordpress-app", {
          namespace: deploymentName,
          ...(webRepo ? { webRepo } : {}),
          ...(webTag ? { webTag } : {}),
          ...(dbRepo ? { dbRepo } : {}),
          ...(dbTag ? { dbTag } : {}),
          ...(storageDb ? { dbStorage: storageDb } : {}),
          ...(storageWeb ? { webStorage: storageWeb } : {}),
        });
      } else if (appType === 'nextcloud') {
        new NextcloudApp(this, "nextcloud-app", {
          namespace: deploymentName,
          ...(webRepo ? { webRepo } : {}),
          ...(webTag ? { webTag } : {}),
          ...(dbRepo ? { dbRepo } : {}),
          ...(dbTag ? { dbTag } : {}),
          ...(storageDb ? { dbStorage: storageDb } : {}),
          ...(storageWeb ? { webStorage: storageWeb } : {}),
        });
      } else if (appType === 'audiobookshelf') {
        new AudiobookshelfApp(this, "audiobookshelf-app", {
          namespace: deploymentName,
          ...(webRepo ? { webRepo } : {}),
          ...(webTag ? { webTag } : {}),
          ...(storageMetadata ? { metadataStorage: storageMetadata } : {}),
          ...(storageConfig ? { configStorage: storageConfig } : {}),
          ...(storageLibrary ? { libraryStorage: storageLibrary } : {}),
        });
      } else if (appType === 'prometheus') {
        new PrometheusApp(this, "prometheus-app", {
          namespace: deploymentName,
          ...(webRepo ? { webRepo } : {}),
          ...(webTag ? { webTag } : {}),
          ...(storageServer ? { serverStorage: storageServer } : {}),
        });
      } else if (appType === 'temporal') {
        new TemporalApp(this, "temporal-app", {
          namespace: deploymentName,
          ...(process.env.TEMPORAL_NAMESPACE ? { namespace: process.env.TEMPORAL_NAMESPACE } : {}),
          ...(process.env.TEMPORAL_IMAGE ? { image: process.env.TEMPORAL_IMAGE } : {}),
          ...(process.env.ENABLE_BACKEND !== undefined ? { enableBackend: process.env.ENABLE_BACKEND === 'true' } : {}),
        });
      } else if (appType === 'traefik') {
        new TraefikApp(this, "traefik-app", {
          namespace: deploymentName,
          ...(webRepo ? { webRepo } : {}),
          ...(webTag ? { webTag } : {}),
        });
      } else {
        new OdooApp(this, "odoo-app", {
          namespace: deploymentName,
          ...(webRepo ? { odooRepo: webRepo } : {}),
          ...(webTag ? { odooTag: webTag } : {}),
          ...(dbRepo ? { pgRepo: dbRepo } : {}),
          ...(dbTag ? { pgTag: dbTag } : {}),
          ...(storageDb ? { dbStorage: storageDb } : {}),
          ...(storageWeb ? { webStorage: storageWeb } : {}),
        });
      }
    }
  }
}

const app = new App();

const stackType = process.env.STACK_TYPE;
const clusterName = process.env.CLUSTER_NAME || "dev-cluster";
// For AppStack, we use a unique ID per deployment for state isolation
const deploymentId = process.env.DEPLOYMENT_ID || 'default';

if (stackType === "cluster") {
  const env = process.env.ENV as ClusterStackConfig["environment"];
  // Two separate stacks, both registered here so `cdktf synth` always generates both — but
  // `cdktf deploy <name>` only ever *applies* the one it's targeted at, so ProvisionClusterActivity
  // / ensure-cluster-stack.ts deploying clusterName then `${clusterName}-observability` (in that
  // order, as two real sequential applies) is what actually matters. See ObservabilityStack's own
  // comment for why this can't be one apply.
  new ClusterStack(app, clusterName, { environment: env, name: clusterName });
  new ObservabilityStack(app, `${clusterName}-observability`, { environment: env, name: clusterName });
} else if (stackType === "app") {
  // Use deploymentId in the stack name to allow multiple deployments on the same cluster
  new AppStack(app, `app-${clusterName}-${deploymentId}`);
} else if (stackType === "vm") {
  // The VM a 'hetzner' cluster will live on — applied strictly *before* the "cluster" stack
  // above, since that one needs a kubeconfig that doesn't exist until k3s is installed on this
  // machine. Registered under its own stack name so its Terraform state stays separate from the
  // cluster's, letting the VM outlive a failed cluster deploy (and be destroyed on its own).
  const sshPublicKey = process.env.VM_SSH_PUBLIC_KEY;
  if (!sshPublicKey) {
    throw new Error("STACK_TYPE=vm requires VM_SSH_PUBLIC_KEY");
  }
  new HetznerVmStack(app, `vm-${clusterName}`, {
    name: clusterName,
    sshPublicKey,
    ...(process.env.HETZNER_SERVER_TYPE ? { serverType: process.env.HETZNER_SERVER_TYPE } : {}),
    ...(process.env.HETZNER_LOCATION ? { location: process.env.HETZNER_LOCATION } : {}),
    ...(process.env.HETZNER_IMAGE ? { image: process.env.HETZNER_IMAGE } : {}),
  });
}

app.synth();

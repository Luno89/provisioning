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
import { OpenWebUiApp } from "./constructs/open-webui.js";
import { MonitoringStack } from "./constructs/monitoring.js";
import { IngressStack } from "./constructs/ingress.js";
import { K8sProviderService } from "./lib/k8s-provider-service.js";
import { VpnConfig } from "./lib/vpn-service.js";

export interface ClusterStackConfig {
  environment: "local" | "k3d" | "aws" | "gcp" | "azure" | "do";
  name: string;
}

/**
 * ClusterStack manages the infrastructure provisioning (e.g. k3d, EKS).
 */
class ClusterStack extends TerraformStack {
  constructor(scope: Construct, id: string, config: ClusterStackConfig) {
    super(scope, id);

    const isLocal = config.environment === "local" || config.environment === "k3d";
    const kubeconfig = process.env.KUBECONFIG_PATH || (isLocal ? "~/.kube/config" : `/tmp/kubeconfig-${config.name}`);
    const context = isLocal ? `k3d-${config.name}` : undefined;

    K8sProviderService.initialize(this, {
      kubeconfigPath: kubeconfig,
      kubeconfigContext: context,
    });

    new BaseCluster(this, "cluster", {
      environment: config.environment,
      name: config.name,
    });

    new MonitoringStack(this, "monitoring");
    new IngressStack(this, "ingress");
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
      } else if (appType === 'openwebui') {
        new OpenWebUiApp(this, "open-webui-app", {
          namespace: deploymentName,
          ...(webRepo ? { webRepo } : {}),
          ...(webTag ? { webTag } : {}),
          ...(process.env.OPENAI_API_BASE_URL ? { openaiApiBaseUrl: process.env.OPENAI_API_BASE_URL } : {}),
          ...(storageDb ? { storage: storageDb } : {}),
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
  new ClusterStack(app, clusterName, { environment: env, name: clusterName });
} else if (stackType === "app") {
  // Use deploymentId in the stack name to allow multiple deployments on the same cluster
  new AppStack(app, `app-${clusterName}-${deploymentId}`);
}

app.synth();

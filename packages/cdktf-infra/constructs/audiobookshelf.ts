import { Construct } from "constructs";
import { Release } from "../.gen/providers/helm/release/index.js";
import { Namespace } from "../.gen/providers/kubernetes/namespace/index.js";

export interface AudiobookshelfConfig {
  readonly namespace?: string;
  readonly webRepo?: string;
  readonly webTag?: string;
  readonly metadataStorage?: string;
  readonly configStorage?: string;
  readonly libraryStorage?: string;
  readonly serviceType?: string;
}

export class AudiobookshelfApp extends Construct {
  constructor(scope: Construct, id: string, config: AudiobookshelfConfig = {}) {
    super(scope, id);

    const namespaceName = config.namespace || "audiobookshelf";
    const ns = new Namespace(this, "ns", {
      metadata: {
        name: namespaceName,
      },
    });

    const serviceType = config.serviceType || (process.env.KUBECONFIG_CONTEXT?.startsWith("k3d-") ? "NodePort" : "LoadBalancer");

    const helmValues: any[] = [
      { name: "service.type", value: serviceType },
      { name: "image.repository", value: config.webRepo || "ghcr.io/advplyr/audiobookshelf" },
      { name: "image.tag", value: config.webTag || "latest" }
    ];

    if (config.metadataStorage) {
      helmValues.push({ name: "persistence.metadata.size", value: config.metadataStorage });
    }
    if (config.configStorage) {
      helmValues.push({ name: "persistence.config.size", value: config.configStorage });
    }
    if (config.libraryStorage) {
      helmValues.push({ name: "persistence.audiobooks.size", value: config.libraryStorage });
    }

    new Release(this, "audiobookshelf-release", {
      name: "audiobookshelf",
      repository: "https://charts.christianhuth.de",
      chart: "audiobookshelf",
      namespace: ns.metadata.name,
      timeout: 600,
      set: helmValues,
    });
  }
}

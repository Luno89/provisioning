import { Construct } from "constructs";
import { Release } from "../.gen/providers/helm/release/index.js";
import { Namespace } from "../.gen/providers/kubernetes/namespace/index.js";
import { defaultServiceType } from "../lib/service-type.js";

export interface TraefikConfig {
  readonly namespace?: string;
  readonly webRepo?: string;
  readonly webTag?: string;
  readonly serviceType?: string;
}

export class TraefikApp extends Construct {
  constructor(scope: Construct, id: string, config: TraefikConfig = {}) {
    super(scope, id);

    const namespaceName = config.namespace || "traefik";
    const ns = new Namespace(this, "ns", {
      metadata: {
        name: namespaceName,
      },
    });

    const serviceType = config.serviceType || defaultServiceType();

    const image = {
      ...(config.webRepo ? { repository: config.webRepo } : {}),
      ...(config.webTag ? { tag: config.webTag } : {}),
    };
    const configValues = {
      service: {
        spec: {
          type: serviceType
        }
      },
      ingressClass: {
        enabled: false
      },
      ports: {
        web: {
          port: 18080
        },
        websecure: {
          port: 18443
        }
      },
      ...(config.webRepo || config.webTag ? { image } : {}),
    };

    new Release(this, "traefik-release", {
      name: "traefik",
      repository: "https://traefik.github.io/charts",
      chart: "traefik",
      version: "41.4.0",
      namespace: ns.metadata.name,
      timeout: 600,
      values: [JSON.stringify(configValues)],
      set: [
        {
          name: "service.spec.type",
          value: serviceType,
        },
      ],
    });
  }
}

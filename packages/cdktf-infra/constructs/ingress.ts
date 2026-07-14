import { Construct } from "constructs";
import { Release } from "../.gen/providers/helm/release/index.js";
import { Namespace } from "../.gen/providers/kubernetes/namespace/index.js";

export class IngressStack extends Construct {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    const ns = new Namespace(this, "ingress-ns", {
      metadata: {
        name: "traefik",
      },
    });

    new Release(this, "traefik-release", {
      name: "traefik",
      repository: "https://traefik.github.io/charts",
      chart: "traefik",
      namespace: ns.metadata.name,
      timeout: 600,
      values: [
        JSON.stringify({
          ingressClass: {
            enabled: true,
          },
          service: {
            spec: {
              type: "ClusterIP",
            },
          },
          ports: {
            web: {
              port: 18080,
            },
            websecure: {
              port: 18443,
            },
          },
          dashboard: {
            enabled: true,
            ingressRoute: {
              enabled: true,
            },
          },
        }),
      ],
      set: [
        {
          name: "service.spec.type",
          value: "ClusterIP",
        },
      ],
    });
  }
}

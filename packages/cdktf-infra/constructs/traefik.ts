import { Construct } from "constructs";
import { Release } from "../.gen/providers/helm/release/index.js";
import { Namespace } from "../.gen/providers/kubernetes/namespace/index.js";

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

    // NodePort, not ClusterIP, for self-managed clusters (k3d, hetzner, remote).
    //
    // ClusterIP left Traefik unreachable from outside the cluster, which quietly broke app
    // exposure on every Hetzner and remote cluster: AppExposureService.buildUpstreamTarget() falls
    // through to a branch that waits on `status.loadBalancer.ingress[0]`, and a ClusterIP Service
    // never populates that. The error was "Cloud LoadBalancer for Traefik's Service is still
    // provisioning", forever, on a cluster that has no load balancer and never will.
    //
    // A NodePort binds on every node interface — including the WireGuard one — so the root node
    // reaches it at <meshIp>:<nodePort> and proxies public traffic in over the mesh. Nothing is
    // opened on the public interface: constructs/hetzner-vm.ts still admits only 22 and WireGuard,
    // and reachability on the mesh is bounded by headscale/config/acl.hujson.
    //
    // LoadBalancer stays the default for real clouds (aws/gcp/azure/do), where a controller exists
    // to satisfy it.
    const serviceType = config.serviceType || (process.env.SELF_MANAGED_K8S === "true" ? "NodePort" : "LoadBalancer");

    const configValues: any = {
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
      }
    };

    if (config.webRepo) {
      configValues.image = configValues.image || {};
      configValues.image.repository = config.webRepo;
    }
    if (config.webTag) {
      configValues.image = configValues.image || {};
      configValues.image.tag = config.webTag;
    }

    new Release(this, "traefik-release", {
      name: "traefik",
      repository: "https://traefik.github.io/charts",
      chart: "traefik",
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

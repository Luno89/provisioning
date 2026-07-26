import { Construct } from "constructs";
import { IngressV1 } from "../.gen/providers/kubernetes/ingress-v1/index.js";

export interface AppIngressConfig {
  readonly namespace: string;
  readonly serviceName: string;
  readonly servicePort: number;
  readonly hostname: string;
}

/**
 * Every app construct calls this right after creating its own Service, so Traefik (already
 * installed on every cluster via IngressStack) actually routes to it — until this existed,
 * Traefik ran on every cluster but proxied zero application traffic; apps were only reachable
 * through AppExposureService's separate host-level Nginx+localtunnel path, which resolved each
 * app's raw Service directly and never consulted Kubernetes Ingress at all. AppExposureService
 * now targets Traefik's own stable Service by this same hostname instead.
 */
export function createAppIngress(scope: Construct, id: string, config: AppIngressConfig): IngressV1 {
  return new IngressV1(scope, id, {
    metadata: {
      name: "app",
      namespace: config.namespace,
    },
    spec: {
      ingressClassName: "traefik",
      rule: [
        {
          host: config.hostname,
          http: {
            path: [
              {
                path: "/",
                pathType: "Prefix",
                backend: {
                  service: {
                    name: config.serviceName,
                    port: { number: config.servicePort },
                  },
                },
              },
            ],
          },
        },
      ],
    },
    // Traefik (a ClusterIP-fronted ingress controller here, not a cloud LoadBalancer) may never
    // populate Ingress.status.loadBalancer the way this flag expects — don't block `cdktf
    // deploy` waiting on it. Same reasoning as gitapp.ts's Deployment `waitForRollout: false`.
    waitForLoadBalancer: false,
  });
}

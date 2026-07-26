import { Construct } from "constructs";
import { Service } from "../.gen/providers/kubernetes/service/index.js";

/**
 * Port plumbing shared by every game-server app type.
 *
 * Game servers differ from every other app this platform deploys in two ways that the normal
 * Ingress/Service path cannot express:
 *
 *  1. **They speak UDP.** A Kubernetes Ingress cannot route UDP at all, and no Service in this
 *     repo had ever set `protocol` before this file existed (everything defaulted to TCP).
 *  2. **The port number is part of the product.** Players type `host:8211` into a server browser.
 *     A NodePort would land somewhere in 30000-32767 and a LoadBalancer needs a cloud controller
 *     that a single-node k3s doesn't have — so neither yields the port players actually need.
 *
 * The answer is `hostPort`: the container binds the real port directly on the node. On the
 * single-node clusters these servers target that is exactly the right semantics — and the usual
 * objection ("only one pod per node") is a feature here, because a second game server on the same
 * port *should* fail to schedule loudly rather than silently share it.
 */
export interface GamePort {
  /** Port number, identical on the container and the host. */
  readonly port: number;
  readonly protocol: "TCP" | "UDP";
  /**
   * Must be unique within the pod and <=15 chars — Kubernetes requires a name once a container
   * declares more than one port.
   */
  readonly name: string;
  /**
   * Player-facing ports get `hostPort` so they are reachable at their real number from outside
   * the node. Control ports (RCON, REST admin) deliberately do not — they stay cluster-internal
   * and are reached through the ClusterIP Service below.
   */
  readonly exposeOnHost?: boolean;
}

/**
 * Builds the container `port` array. Ports marked `exposeOnHost` bind `hostPort` on the node;
 * the rest are declared for documentation and Service targeting only.
 */
export function buildGameContainerPorts(ports: readonly GamePort[]): Array<Record<string, unknown>> {
  return ports.map((p) => ({
    name: p.name,
    containerPort: p.port,
    protocol: p.protocol,
    ...(p.exposeOnHost ? { hostPort: p.port } : {}),
  }));
}

export interface GameServiceConfig {
  readonly namespace: string;
  readonly serviceName: string;
  /** Pod selector — must match the Deployment's template labels. */
  readonly selector: Record<string, string>;
  readonly ports: readonly GamePort[];
}

/**
 * Creates the cluster-internal Service for a game server.
 *
 * Deliberately **TCP-only and ClusterIP-only**: the player-facing UDP ports reach the pod via
 * `hostPort` and never go through a Service at all. That keeps the repo's existing invariant —
 * no Service sets `protocol`, no Service is UDP — intact, and avoids depending on the
 * `SELF_MANAGED_K8S` serviceType heuristic that every other construct branches on.
 *
 * What this Service is actually for: giving the blackbox probe (lib/app-probe.ts, `tcp_connect`)
 * and any in-cluster admin tooling a stable DNS name for the control ports.
 */
export function createGameServerService(
  scope: Construct,
  id: string,
  config: GameServiceConfig,
): Service {
  const tcpPorts = config.ports.filter((p) => p.protocol === "TCP");
  if (tcpPorts.length === 0) {
    throw new Error(
      `createGameServerService(${config.serviceName}): no TCP ports — a game server needs at ` +
        `least one TCP control port for the health probe to target.`,
    );
  }

  return new Service(scope, id, {
    metadata: {
      name: config.serviceName,
      namespace: config.namespace,
    },
    spec: {
      type: "ClusterIP",
      selector: config.selector,
      port: tcpPorts.map((p) => ({
        name: p.name,
        port: p.port,
        // String, not number — the generated Kubernetes binding types targetPort as a string
        // (it accepts a named port as well as a number).
        targetPort: String(p.port),
      })),
    },
    // No cloud load balancer is ever involved for a ClusterIP Service; waiting would hang.
    waitForLoadBalancer: false,
  });
}

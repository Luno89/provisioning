import { Service } from "../.gen/providers/kubernetes/service/index.js";
/**
 * Builds the container `port` array. Ports marked `exposeOnHost` bind `hostPort` on the node;
 * the rest are declared for documentation and Service targeting only.
 */
export function buildGameContainerPorts(ports) {
    return ports.map((p) => ({
        name: p.name,
        containerPort: p.port,
        protocol: p.protocol,
        ...(p.exposeOnHost ? { hostPort: p.port } : {}),
    }));
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
export function createGameServerService(scope, id, config) {
    const tcpPorts = config.ports.filter((p) => p.protocol === "TCP");
    if (tcpPorts.length === 0) {
        throw new Error(`createGameServerService(${config.serviceName}): no TCP ports — a game server needs at ` +
            `least one TCP control port for the health probe to target.`);
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

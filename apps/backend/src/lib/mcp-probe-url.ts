import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mcpProbeUrlFor } from './mcp-registry.js';

const sh = promisify(execFile);

/**
 * How the BACKEND reaches a deployed MCP server.
 *
 * Deliberately not the in-cluster Service address. The backend runs on the host and cannot resolve
 * `*.svc.cluster.local` at all, so probing through the address a sandbox uses fails with a bare
 * "fetch failed" that reads exactly like a dead server — confirmed the hard way. The Service is a
 * NodePort, so the node's own address works from here.
 *
 * Returns undefined rather than throwing: a deployment with no NodePort is a deployment the backend
 * simply has no route to, which is a fact the registry reports rather than an error.
 */
export async function resolveMcpProbeUrl(namespace: string): Promise<string | undefined> {
  try {
    const [{ stdout: ip }, { stdout: port }] = await Promise.all([
      sh('kubectl', ['get', 'nodes', '-o',
        'jsonpath={.items[0].status.addresses[?(@.type=="InternalIP")].address}']),
      sh('kubectl', ['get', 'svc', 'gitapp', '-n', namespace, '-o', 'jsonpath={.spec.ports[0].nodePort}']),
    ]);
    // A dual-stack node reports several InternalIPs space-joined; IPv4 is always first.
    const host = ip.trim().split(/\s+/)[0];
    const nodePort = Number(port.trim());
    if (!host || !Number.isFinite(nodePort) || nodePort === 0) return undefined;
    return mcpProbeUrlFor(host, nodePort);
  } catch {
    return undefined;
  }
}

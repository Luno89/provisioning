import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mcpProbeUrlFor } from './mcp-registry.js';
import { McpClient } from './mcp-client.js';

const sh = promisify(execFile);

export async function resolveMcpProbeUrl(namespace: string): Promise<string | undefined> {
  try {
    const [{ stdout: ip }, { stdout: port }] = await Promise.all([
      sh('kubectl', ['get', 'nodes', '-o',
        'jsonpath={.items[0].status.addresses[?(@.type=="InternalIP")].address}']),
      sh('kubectl', ['get', 'svc', 'gitapp', '-n', namespace, '-o', 'jsonpath={.spec.ports[0].nodePort}']),
    ]);
    const host = ip.trim().split(/\s+/)[0];
    const nodePort = Number(port.trim());
    if (!host || !Number.isFinite(nodePort) || nodePort === 0) return undefined;
    return mcpProbeUrlFor(host, nodePort);
  } catch {
    return undefined;
  }
}

export async function probeMcpDeployment(namespace: string, fetchImpl: typeof fetch = fetch): Promise<{ unreachable?: string | undefined; tools: number }> {
  const url = await resolveMcpProbeUrl(namespace);
  if (!url) return { unreachable: 'No NodePort resolved for this deployment, so the backend has no route to it.', tools: 0 };
  try {
    return { tools: (await new McpClient(url, fetchImpl).listTools()).length };
  } catch (err) {
    return { unreachable: String((err as Error)?.message ?? err).slice(0, 200), tools: 0 };
  }
}

export const PROBE_TTL_MS = 10 * 60 * 1000;

export function cachedProbes(probe: (namespace: string) => Promise<{ unreachable?: string | undefined; tools: number }> = probeMcpDeployment, ttlMs = PROBE_TTL_MS, now: () => number = Date.now) {
  const seen = new Map<string, { at: number; result: { unreachable?: string | undefined; tools: number } }>();
  return async (namespace: string): Promise<{ unreachable?: string | undefined; tools: number }> => {
    const known = seen.get(namespace);
    if (known && now() - known.at < ttlMs && !known.result.unreachable) return known.result;
    const result = await probe(namespace);
    seen.set(namespace, { at: now(), result });
    return result;
  };
}

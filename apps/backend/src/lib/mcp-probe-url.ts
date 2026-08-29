import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mcpProbeUrlFor } from './mcp-registry.js';

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

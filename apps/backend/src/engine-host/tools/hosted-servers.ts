import { McpClient, type Fetcher } from '../../lib/mcp-client.js';
import type { ServerRuns } from '../../lib/mcp-servers.js';
import type { HostedServers } from './server-tools.js';

export function hostedCaller(
  hostedUrl: (ownerId: string, runs: Extract<ServerRuns, { where: 'hosted' }>) => Promise<string | undefined>,
  fetchImpl: Fetcher = fetch,
): HostedServers['call'] {
  return async (ownerId, runs, tool, args) => {
    const url = await hostedUrl(ownerId, runs);
    if (!url) return { text: 'the server has no address this platform can reach: its deployment is not running, or nothing routes to it', isError: true };
    try {
      return await new McpClient(url, fetchImpl).callTool(tool, args);
    } catch (err) {
      return { text: `the server did not answer at ${url}: ${(err as Error).message.slice(0, 200)}`, isError: true };
    }
  };
}

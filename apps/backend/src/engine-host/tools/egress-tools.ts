import { randomUUID } from 'node:crypto';
import type { ToolHandler, ToolOutcome } from '@koala/engine-core';
import type { EgressGrantRecord, EgressRequest } from '@koala/harness-types';
import { hostProblem, portsProblem } from '../../lib/egress-proxy.js';
import type { Tree } from '../../lib/trees.js';

export interface EgressToolStores {
  grants(ownerId: string): Promise<EgressGrantRecord[]>;
  requests: {
    list(ownerId: string): Promise<EgressRequest[]>;
    save(request: EgressRequest): Promise<void>;
  };
  trees: { list(): Promise<Tree[]> };
}

const asString = (parsed: Record<string, unknown>, key: string): string | undefined => {
  const value = parsed[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
};

const refuse = (reason: string): ToolOutcome => ({ ok: false, digest: reason, content: reason });

export function createEgressTools(options: {
  stores: EgressToolStores;
  now?: (() => string) | undefined;
  newId?: (() => string) | undefined;
}): Record<string, ToolHandler> {
  const now = options.now ?? (() => new Date().toISOString());
  const newId = options.newId ?? randomUUID;

  return {
    async request_egress({ parsed, caller }): Promise<ToolOutcome> {
      if (!caller.ownerId || !caller.agentSlug) return refuse('this run has no owner or agent to ask for');
      const host = (asString(parsed, 'host') ?? '').toLowerCase().replace(/^https?:\/\//, '').replace(/[/:].*$/, '');
      const hostIssue = hostProblem(host);
      if (hostIssue) return refuse(hostIssue);
      const port = parsed.port === undefined ? undefined : Number(parsed.port);
      const ports = port === undefined ? undefined : [port];
      if (ports) {
        const portIssue = portsProblem(ports);
        if (portIssue) return refuse(portIssue);
      }
      const why = asString(parsed, 'why');
      if (!why) return refuse('say why the work needs this host, so the person can decide');

      const granted = (await options.stores.grants(caller.ownerId))
        .find((grant) => grant.agentSlug === caller.agentSlug && grant.host === host && !grant.revokedAt
          && (!ports || (grant.ports ?? [443]).includes(ports[0]!)));
      if (granted) {
        return { ok: true, digest: `${host}: already granted`, content: `${host} is already granted to you; a new run of yours reaches it through the proxy.` };
      }
      const open = (await options.stores.requests.list(caller.ownerId))
        .find((request) => request.status === 'requested' && request.agentSlug === caller.agentSlug && request.host === host);
      if (open) return { ok: true, digest: `${host}: already asked`, content: `Already asked the person to let you reach ${host}; nothing new was asked.` };

      const tree = caller.projectId
        ? (await options.stores.trees.list()).find((candidate) => candidate.ownerId === caller.ownerId && candidate.projectIds?.includes(caller.projectId!))
        : undefined;
      const stamp = now();
      await options.stores.requests.save({
        id: newId(),
        ownerId: caller.ownerId,
        agentSlug: caller.agentSlug,
        host,
        ...(ports ? { ports } : {}),
        why,
        status: 'requested',
        ...(caller.conversationId ? { conversationId: caller.conversationId } : {}),
        ...(tree ? { treeId: tree.id } : {}),
        ...(caller.runId ? { runId: caller.runId } : {}),
        createdAt: stamp,
        updatedAt: stamp,
      });
      return {
        ok: true,
        digest: `${host}: asked`,
        content: `Asked the person to let you reach ${host}. It stays blocked for this run; if they allow it, runs that start afterwards reach it. Carry on with what you can do without it, or stop and say what is waiting on it.`,
      };
    },
  };
}

import { randomUUID } from 'node:crypto';
import { grantChanges, kindOfGrant, type Install, type PersonaRecord, type ToolDefinition, type ToolGrant } from '@koala/agent-engine';
import { looksLikeMcp } from './mcp-registry.js';
import { MCP_TOOL_KINDS, deploymentOf, serverNameFrom, type McpServerRecord, type McpToolKind } from './mcp-servers.js';
import type { McpToolHint } from './mcp-tool-hints.js';
import { serviceNameFor, usableServiceName } from './service-name.js';
import type { DeploymentMetadata, ProjectMetadata } from './types.js';
import type { Tree } from './trees.js';

export interface McpServerMigrationStore {
  getUsers(): Promise<{ id: string }[]>;
  getEnginePersonas(): Promise<PersonaRecord[]>;
  saveEnginePersona(persona: PersonaRecord): Promise<void>;
  getEngineTools(ownerId?: string): Promise<ToolDefinition[]>;
  deleteEngineTool(ownerId: string | undefined, name: string): Promise<void>;
  getToolGrants(ownerId: string): Promise<ToolGrant[]>;
  saveToolGrant(grant: ToolGrant & { ownerId: string }): Promise<void>;
  deleteToolGrant(ownerId: string, agent: string, tool: string, kind?: 'tool' | 'server' | undefined): Promise<void>;
  getMcpServers(ownerId: string): Promise<McpServerRecord[]>;
  saveMcpServer(server: McpServerRecord): Promise<void>;
  getMcpToolHints(ownerId: string): Promise<McpToolHint[]>;
  deleteMcpToolHint(ownerId: string, server: string, tool: string): Promise<void>;
  getDeployments(): Promise<DeploymentMetadata[]>;
  getProjects(): Promise<ProjectMetadata[]>;
  getTrees(): Promise<Tree[]>;
}

export interface McpServerMigration {
  agentServerListsMoved: number;
  servingToolsMoved: number;
  toolKindsMoved: number;
}

const WHY = 'held by this agent before MCP servers were granted';

type ServingTool = ToolDefinition & { ownerId?: string | undefined; install?: Install | undefined; needsBinaries?: string[] | undefined; serves?: { start: string; port: number; path?: string | undefined; offer?: string[] | undefined; omit?: string[] | undefined } };

export async function migrateMcpServers(store: McpServerMigrationStore, now: string, newId: () => string = randomUUID): Promise<McpServerMigration> {
  const moved: McpServerMigration = { agentServerListsMoved: 0, servingToolsMoved: 0, toolKindsMoved: 0 };

  for (const row of await store.getEnginePersonas()) {
    const listed = (row as PersonaRecord & { mcp?: unknown }).mcp;
    if (listed === undefined) continue;
    const { mcp: _mcp, ...record } = row as PersonaRecord & { mcp?: unknown };
    if (row.ownerId !== undefined && Array.isArray(listed)) {
      const wanted = listed.filter((name): name is string => typeof name === 'string');
      const changes = grantChanges(row.slug, wanted, [], await store.getToolGrants(row.ownerId), 'server');
      for (const name of changes.grant) await store.saveToolGrant({ ownerId: row.ownerId, agent: row.slug, tool: name, kind: 'server', grantedAt: now, why: WHY });
    }
    await store.saveEnginePersona(record);
    moved.agentServerListsMoved += 1;
  }

  for (const tool of (await store.getEngineTools()) as ServingTool[]) {
    if (!tool.serves || !tool.ownerId) continue;
    const ownerId = tool.ownerId;
    const servers = await store.getMcpServers(ownerId);
    const name = servers.some((server) => server.name === tool.name.replace(/_/g, '-')) ? undefined : serverNameFrom(tool.name.replace(/_/g, '-'), new Set(servers.map((server) => server.name)));
    if (name) {
      await store.saveMcpServer({
        id: newId(),
        ownerId,
        name,
        summary: tool.summary,
        ...(tool.guidance ? { notes: tool.guidance } : {}),
        runs: {
          where: 'workspace',
          install: tool.install && tool.install.via !== 'base' ? [tool.install] : [],
          ...(tool.needsBinaries?.length ? { needsBinaries: tool.needsBinaries } : {}),
          start: tool.serves.start,
          port: tool.serves.port,
          ...(tool.serves.path ? { path: tool.serves.path } : {}),
        } as unknown as McpServerRecord['runs'],
        ...(tool.serves.offer ? { offer: tool.serves.offer } : {}),
        ...(tool.serves.omit ? { omit: tool.serves.omit } : {}),
        createdAt: now,
        updatedAt: now,
      });
    }
    const serverName = name ?? tool.name.replace(/_/g, '-');
    for (const grant of (await store.getToolGrants(ownerId)).filter((entry) => kindOfGrant(entry) === 'tool' && entry.tool === tool.name)) {
      await store.deleteToolGrant(ownerId, grant.agent, tool.name);
      if (!grant.revoked) await store.saveToolGrant({ ownerId, agent: grant.agent, tool: serverName, kind: 'server', grantedAt: grant.grantedAt ?? now, why: grant.why ?? WHY });
    }
    await store.deleteEngineTool(ownerId, tool.name);
    moved.servingToolsMoved += 1;
  }

  const [deployments, projects, trees] = await Promise.all([store.getDeployments(), store.getProjects(), store.getTrees()]);
  for (const user of await store.getUsers()) {
    const hints = await store.getMcpToolHints(user.id);
    if (hints.length === 0) continue;
    const servers = await store.getMcpServers(user.id);
    for (const deployment of deployments.filter((entry) => entry.ownerId === user.id && looksLikeMcp(entry))) {
      if (servers.some((server) => deploymentOf(server) === deployment.id)) continue;
      const project = projects.find((entry) => entry.id === deployment.gitappProjectId && entry.ownerId === user.id);
      const tree = project ? trees.find((entry) => entry.ownerId === user.id && (entry.projectIds ?? []).includes(project.id)) : undefined;
      const declared = usableServiceName((tree as { serviceName?: unknown } | undefined)?.serviceName);
      const server: McpServerRecord = {
        id: newId(),
        ownerId: user.id,
        name: serverNameFrom(serviceNameFor({ ...(declared ? { declared } : {}), ...(tree?.name ? { treeName: tree.name } : {}), ...(project?.name ? { projectName: project.name } : {}), deploymentName: deployment.name }), new Set(servers.map((entry) => entry.name))),
        runs: { where: 'hosted', deploymentId: deployment.id },
        ...(deployment.gitappProjectId ? { from: { projectId: deployment.gitappProjectId } } : {}),
        createdAt: now,
        updatedAt: now,
      };
      await store.saveMcpServer(server);
      servers.push(server);
    }
    for (const hint of hints) {
      const server = servers.find((entry) => entry.name === hint.server);
      if (server && (MCP_TOOL_KINDS as readonly string[]).includes(hint.choice)) {
        const tools = { ...(server.tools ?? {}), [hint.tool]: { ...(server.tools?.[hint.tool] ?? {}), kind: hint.choice as McpToolKind } };
        Object.assign(server, { tools, updatedAt: now });
        await store.saveMcpServer(server);
        moved.toolKindsMoved += 1;
      }
      await store.deleteMcpToolHint(user.id, hint.server, hint.tool);
    }
  }

  return moved;
}

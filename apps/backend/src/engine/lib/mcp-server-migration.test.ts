import { describe, expect, it } from 'vitest';
import type { PersonaRecord, ToolDefinition, ToolGrant } from '@koala/agent-engine';
import { migrateMcpServers, type McpServerMigrationStore } from './mcp-server-migration.js';
import type { McpServerRecord } from './mcp-servers.js';
import type { McpToolHint } from './mcp-tool-hints.js';

function store(seed: { personas?: PersonaRecord[]; tools?: ToolDefinition[]; grants?: (ToolGrant & { ownerId: string })[]; hints?: McpToolHint[]; servers?: McpServerRecord[] } = {}) {
  let personas = [...(seed.personas ?? [])];
  let tools = [...(seed.tools ?? [])] as (ToolDefinition & { ownerId?: string })[];
  let grants = [...(seed.grants ?? [])];
  let hints = [...(seed.hints ?? [])];
  const servers = [...(seed.servers ?? [])];
  let ids = 0;
  const db: McpServerMigrationStore = {
    accounts: {
      getUsers: async () => [{ id: 'u1' }],
    },
    engine: {
      getEnginePersonas: async () => personas,
      saveEnginePersona: async (persona) => { personas = [...personas.filter((one) => one.slug !== persona.slug), persona]; },
      getEngineTools: async () => tools,
      deleteEngineTool: async (ownerId, name) => { tools = tools.filter((one) => !(one.ownerId === ownerId && one.name === name)); },
      getToolGrants: async (ownerId) => grants.filter((one) => one.ownerId === ownerId),
      saveToolGrant: async (grant) => { grants = [...grants.filter((one) => !(one.agent === grant.agent && one.tool === grant.tool && (one.kind ?? 'tool') === (grant.kind ?? 'tool'))), grant]; },
      deleteToolGrant: async (ownerId, agent, tool, kind) => { grants = grants.filter((one) => !(one.ownerId === ownerId && one.agent === agent && one.tool === tool && (one.kind ?? 'tool') === (kind ?? 'tool'))); },
      getMcpServers: async (ownerId) => servers.filter((one) => one.ownerId === ownerId),
      saveMcpServer: async (server) => { const at = servers.findIndex((one) => one.id === server.id); if (at >= 0) servers[at] = server; else servers.push(server); },
      getMcpToolHints: async (ownerId) => hints.filter((one) => one.ownerId === ownerId),
      deleteMcpToolHint: async (ownerId, server, tool) => { hints = hints.filter((one) => !(one.ownerId === ownerId && one.server === server && one.tool === tool)); },
    },
    infrastructure: {
      getDeployments: async () => [{ id: 'd1', name: 'weather-api', ownerId: 'u1', status: 'running', appType: 'gitapp', gitappProjectId: 'p1' } as never],
    },
    projects: {
      getProjects: async () => [{ id: 'p1', name: 'Weather', ownerId: 'u1' } as never],
      getTrees: async () => [],
    },
  };
  return { db, read: () => ({ personas, tools, grants, hints, servers }), newId: () => `m${(ids += 1)}` };
}

describe('moving MCP servers onto the catalogue', () => {
  it('turns an agent\'s list of servers into server grants, and leaves the list behind', async () => {
    const { db, read, newId } = store({ personas: [{ slug: 'helper', ownerId: 'u1', name: 'Helper', mcp: ['gitea', 7] } as unknown as PersonaRecord] });
    expect(await migrateMcpServers(db, 't', newId)).toMatchObject({ agentServerListsMoved: 1 });
    expect(read().grants).toEqual([{ ownerId: 'u1', agent: 'helper', tool: 'gitea', kind: 'server', grantedAt: 't', why: 'held by this agent before MCP servers were granted' }]);
    expect(read().personas[0]).not.toHaveProperty('mcp');
    expect(await migrateMcpServers(db, 't', newId)).toMatchObject({ agentServerListsMoved: 0 });
  });

  it('turns a tool that served into a workspace server, its grants into server grants, and drops the tool', async () => {
    const serving = {
      name: 'browser_tool', ownerId: 'u1', summary: 'A browser', guidance: 'Snapshot first.', binding: 'environment', effect: 'write',
      parameters: { type: 'object', properties: {} }, returns: 'x', failures: [],
      serves: { start: 'playwright-mcp --port 8931', port: 8931, omit: ['browser_take_screenshot'] },
      needsBinaries: ['curl'], install: { via: 'npm', packages: ['@playwright/mcp'] },
    } as unknown as ToolDefinition;
    const { db, read, newId } = store({ tools: [serving], grants: [{ ownerId: 'u1', agent: 'executor', tool: 'browser_tool' }] });
    expect(await migrateMcpServers(db, 't', newId)).toMatchObject({ servingToolsMoved: 1 });
    expect(read().servers).toEqual([expect.objectContaining({
      name: 'browser-tool', summary: 'A browser', notes: 'Snapshot first.', omit: ['browser_take_screenshot'],
      runs: { where: 'workspace', install: [{ via: 'npm', packages: ['@playwright/mcp'] }], needsBinaries: ['curl'], start: 'playwright-mcp --port 8931', port: 8931 },
    })]);
    expect(read().grants).toEqual([expect.objectContaining({ agent: 'executor', tool: 'browser-tool', kind: 'server' })]);
    expect(read().tools).toEqual([]);
  });

  it('records the person\'s kind for a tool on its server, making the deployment\'s record if there is none yet', async () => {
    const { db, read, newId } = store({ hints: [{ ownerId: 'u1', server: 'weather', tool: 'forecast', choice: 'read-only', updatedAt: 't' }, { ownerId: 'u1', server: 'gone', tool: 'x', choice: 'destructive', updatedAt: 't' }] });
    expect(await migrateMcpServers(db, 't', newId)).toMatchObject({ toolKindsMoved: 1 });
    expect(read().servers).toEqual([expect.objectContaining({ name: 'weather', runs: { where: 'hosted', deploymentId: 'd1' }, from: { projectId: 'p1' }, tools: { forecast: { kind: 'read-only' } } })]);
    expect(read().hints).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { testDatabase } from '../../platform/lib/test-database.js';
import { migrateToDependencies, programOf } from './dependency-migration.js';
import { runsFingerprint, serverState, type McpServerRecord } from './mcp-servers.js';
import { SHIPPED_DEPENDENCIES } from '../../extensions/workspace-dependencies.js';

const tool = (over: Record<string, unknown>) => ({
  summary: 's', binding: 'environment', effect: 'read', idempotent: true, openWorld: false, returns: 'r',
  failures: [{ when: 'w', says: 's' }], parameters: { type: 'object', properties: {} }, ...over,
}) as never;

describe('moving inline installs onto dependencies', () => {
  it('points a tool at the shipped dependency that installs the same, or one of the person\'s own, once', async () => {
    const db = await testDatabase();
    await db.init();
    await db.accounts.saveUser({ id: 'u1', email: 'u1@test' } as never);
    await db.saveEngineTool(tool({ name: 'json_query', ownerId: 'u1', needsBinaries: ['jq'], install: { via: 'dnf', packages: ['jq'] } }));
    await db.saveEngineTool(tool({ name: 'pdf_text', ownerId: 'u1', needsBinaries: ['pdftotext'], install: { via: 'dnf', packages: ['poppler-utils'] } }));
    await db.saveEngineTool(tool({ name: 'plain', ownerId: 'u1' }));

    expect(await migrateToDependencies(db as never, SHIPPED_DEPENDENCIES)).toEqual({ toolsMoved: 2, serversMoved: 0, dependenciesMade: 1, left: [] });
    const tools = await db.getEngineTools('u1');
    expect(tools.find((entry) => entry.name === 'json_query')).toMatchObject({ needs: ['jq'] });
    expect(tools.find((entry) => entry.name === 'json_query')).not.toHaveProperty('install');
    expect(tools.find((entry) => entry.name === 'pdf_text')).toMatchObject({ needs: ['poppler-utils'] });
    expect(await db.getWorkspaceDependencies('u1')).toEqual([expect.objectContaining({ name: 'poppler-utils', provides: ['pdftotext'], install: [{ via: 'dnf', packages: ['poppler-utils'] }], ownerId: 'u1' })]);

    expect(await migrateToDependencies(db as never, SHIPPED_DEPENDENCIES)).toEqual({ toolsMoved: 0, serversMoved: 0, dependenciesMade: 0, left: [] });
  });

  it('moves a workspace server onto what it needs and keeps its capture, so it stays usable', async () => {
    const db = await testDatabase();
    await db.init();
    await db.accounts.saveUser({ id: 'u1', email: 'u1@test' } as never);
    const legacy = { where: 'workspace', languages: ['node'], install: [{ via: 'npm', packages: ['@playwright/mcp@0.0.83'] }], start: 'PLAYWRIGHT_BROWSERS_PATH=/x playwright-mcp --port 8931', port: 8931 } as never;
    const tickets = { where: 'workspace', install: [{ via: 'npm', packages: ['tickets-mcp'] }], start: 'tickets-mcp --port 9100', port: 9100 } as never;
    const captured = (runs: McpServerRecord['runs']) => ({ tools: [{ name: 'browser_navigate' }], at: 't1', fingerprint: runsFingerprint(runs) });
    await db.saveMcpServer({ id: 'p', ownerId: 'u1', name: 'playwright', runs: legacy, from: { template: 'playwright' }, captured: captured(legacy), createdAt: 't', updatedAt: 't' });
    await db.saveMcpServer({ id: 't', ownerId: 'u1', name: 'tickets', runs: tickets, captured: captured(tickets), createdAt: 't', updatedAt: 't' });

    expect(await migrateToDependencies(db as never, SHIPPED_DEPENDENCIES)).toMatchObject({ serversMoved: 2, dependenciesMade: 1, left: [] });
    const servers = await db.getMcpServers('u1');
    const playwright = servers.find((server) => server.name === 'playwright')!;
    expect(playwright.runs).toEqual({ where: 'workspace', languages: ['node'], needs: ['playwright-mcp'], start: 'PLAYWRIGHT_BROWSERS_PATH=/x playwright-mcp --port 8931', port: 8931 });
    expect(serverState(playwright)).toEqual({ state: 'captured', tools: 1 });
    expect(servers.find((server) => server.name === 'tickets')!.runs).toMatchObject({ needs: ['tickets-server'] });
    expect(await db.getWorkspaceDependencies('u1')).toEqual([expect.objectContaining({ name: 'tickets-server', provides: ['tickets-mcp'] })]);
  });

  it('reads the program a server is started with', () => {
    expect(programOf('PORT=1 echoes-server')).toBe('echoes-server');
    expect(programOf('/usr/local/bin/serve --x')).toBe('serve');
    expect(programOf('npx some-mcp')).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { BASES, type AgentDefinition, type ToolDefinition } from '@koala/agent-engine';
import { composeWorkspace } from './workspace-composition.js';
import type { McpServerRecord } from './mcp-servers.js';

const executor = { slug: 'executor', tools: ['count_lines'], environment: { terminal: true, filesystem: true, languages: ['node'] } } as unknown as AgentDefinition;
const countLines = { name: 'count_lines', binding: 'environment', needsBinaries: ['rg'], install: { via: 'dnf', packages: ['ripgrep'] } } as unknown as ToolDefinition;

describe('composing a workspace', () => {
  it('puts the project\'s needs and the agents\' tools into one image, each line saying where it came from', () => {
    const composed = composeWorkspace({ agent: executor, tools: [countLines], file: { packages: { dnf: ['wkhtmltopdf'] }, languages: ['go'], env: [{ name: 'SHOP', value: 'demo' }] } }, BASES)!;

    expect(composed.plan.lines?.map((line) => line.from)).toEqual(['language:go', 'project', 'tool:count_lines']);
    expect(composed.env).toEqual([{ name: 'SHOP', value: 'demo' }]);
  });

  it('is the agent\'s own image when there is no project file, and nothing for an agent with no machine', () => {
    expect(composeWorkspace({ agent: executor, tools: [countLines] }, BASES)!.plan.lines?.map((line) => line.from)).toEqual(['tool:count_lines']);
    expect(composeWorkspace({ agent: { ...executor, environment: {} }, tools: [] }, BASES)).toBeUndefined();
  });
});

describe('a workspace with the MCP servers its agents hold', () => {
  const playwright = { id: 'p', ownerId: 'u1', name: 'playwright', runs: { where: 'workspace', languages: ['python'], install: [{ via: 'npm', packages: ['@playwright/mcp'] }], start: 'playwright-mcp', port: 8931 }, createdAt: 't', updatedAt: 't' } as McpServerRecord;
  const docs = { id: 'd', ownerId: 'u1', name: 'docs', runs: { where: 'hosted', url: 'http://docs.test/mcp' }, createdAt: 't', updatedAt: 't' } as McpServerRecord;

  it('installs each held workspace server, with what it needs, each line saying it is the server\'s', () => {
    const composed = composeWorkspace({ agent: { ...executor, servers: ['playwright', 'docs'] }, tools: [countLines], servers: [playwright, docs] }, BASES)!;
    expect(composed.plan.lines?.map((line) => line.from)).toEqual(['language:python', 'server:playwright', 'tool:count_lines']);
  });

  it('installs nothing for a server the agent does not hold', () => {
    expect(composeWorkspace({ agent: executor, tools: [countLines], servers: [playwright] }, BASES)!.plan.lines?.map((line) => line.from)).toEqual(['tool:count_lines']);
  });
});

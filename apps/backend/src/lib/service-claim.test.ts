import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { claimService, claimNotice } from './service-claim.js';

const tree = (over: Partial<any> = {}) =>
  ({ id: 't2', ownerId: 'u1', name: 'GitHub MCP v2', ...over });
const owner = (over: Partial<any> = {}) =>
  ({ id: 't1', ownerId: 'u1', name: 'GitHub API MCP', serviceName: 'github-mcp', projectIds: ['p-1'], ...over });

describe('a name another tree already owns', () => {
  it('adopts that service\'s repository instead of starting a rival', () => {
    const claim = claimService('github-mcp', tree(), [owner(), tree()]);
    expect(claim.adoptProjectId).toBe('p-1');
    expect(claim.ownedBy?.treeName).toBe('GitHub API MCP');
  });

  it('matches on case and spacing, because the claim is an identity not a string', () => {
    expect(claimService('  GitHub-MCP  ', tree(), [owner(), tree()]).adoptProjectId).toBe('p-1');
  });

  it('says so, rather than repointing silently', () => {
    const text = claimNotice('github-mcp', claimService('github-mcp', tree(), [owner(), tree()]));
    expect(text).toContain('GitHub API MCP');
    expect(text).toMatch(/existing\s+repository/);
    expect(text).toMatch(/rebuild and redeploy/);
  });
});

describe('what it must not do', () => {
  it('leaves a free name alone', () => {
    expect(claimService('weather', tree(), [owner(), tree()])).toEqual({});
    expect(claimNotice('weather', {})).toBe('');
  });

  it('does not claim against ANOTHER USER\'s service', () => {
    expect(claimService('github-mcp', tree(), [owner({ ownerId: 'u2' }), tree()])).toEqual({});
  });

  it('does not match a tree against itself', () => {
    const self = tree({ id: 't1', serviceName: 'github-mcp', projectIds: ['p-1'] });
    expect(claimService('github-mcp', self, [self])).toEqual({});
  });

  it('does NOT repoint a tree that already has a repository', () => {
    const claim = claimService('github-mcp', tree({ projectIds: ['p-mine'] }), [owner(), tree()]);
    expect(claim.adoptProjectId).toBeUndefined();
    expect(claim.ownedBy).toBeTruthy();
  });

  it('warns about the collision when it cannot adopt', () => {
    const claim = claimService('github-mcp', tree({ projectIds: ['p-mine'] }), [owner(), tree()]);
    expect(claimNotice('github-mcp', claim)).toMatch(/share the prefix on every tool/);
  });

  it('handles an owner tree that has no project yet', () => {
    const claim = claimService('github-mcp', tree(), [owner({ projectIds: [] }), tree()]);
    expect(claim.adoptProjectId).toBeUndefined();
    expect(claim.ownedBy).toBeTruthy();
  });

  it('ignores an empty name', () => {
    expect(claimService('   ', tree(), [owner()])).toEqual({});
  });
});

describe('how the route applies it', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const route = readFileSync(join(here, '../routes/chat.ts'), 'utf8');

  it('attaches the adopted project to the tree', () => {
    expect(route).toMatch(/withProject\(\{ \.\.\.tree, serviceName: declaredName, updatedAt: now \}, claim\.adoptProjectId\)/);
  });

  it('posts the notice to the branch', () => {
    expect(route).toMatch(/const text = claimNotice\(declaredName, claim\)/);
  });

  it('only claims against this user\'s trees', () => {
    expect(route).toMatch(/claimService\(declaredName, tree, await ownedTrees\(/);
  });
});

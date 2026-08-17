import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { claimService, claimNotice } from './service-claim.js';

/**
 * Two conversations about one service landing in one repository.
 *
 * ── WHAT HAPPENED ──
 * A second run was asked for the same GitHub MCP server. The planner did everything right: it
 * called `list_mcp_servers`, found `github-mcp` already running with three tools, said "No need to
 * rebuild it", and proposed only a leaf to verify it — naming the project the server is built from.
 *
 * The leaf built in a NEW repository anyway. `resolveLeafProject` reads the leaf's project, then
 * the tree's, then falls back to one per branch — and the new tree had no project, because knowing
 * a project id in prose is not attaching it. Two deployments then answered to `github-mcp`, with
 * two Terraform states and two sets of identically-prefixed tools, and that collision had to be
 * worked around in the chat grant, the persona picker and the registry listing before anyone fixed
 * the identity bug underneath.
 */

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
    /**
     * The name is per user. Two tenants naming their service `github-mcp` have nothing to do with
     * each other, and adopting across them would hand one user's repository to another.
     */
    expect(claimService('github-mcp', tree(), [owner({ ownerId: 'u2' }), tree()])).toEqual({});
  });

  it('does not match a tree against itself', () => {
    // Re-declaring its own name must not make a tree adopt its own project as if it were someone
    // else's, nor post a notice about itself.
    const self = tree({ id: 't1', serviceName: 'github-mcp', projectIds: ['p-1'] });
    expect(claimService('github-mcp', self, [self])).toEqual({});
  });

  it('does NOT repoint a tree that already has a repository', () => {
    /**
     * The same failure in the other direction. Adopting into a tree whose work is already landing
     * somewhere would move it mid-effort.
     */
    const claim = claimService('github-mcp', tree({ projectIds: ['p-mine'] }), [owner(), tree()]);
    expect(claim.adoptProjectId).toBeUndefined();
    expect(claim.ownedBy).toBeTruthy();
  });

  it('warns about the collision when it cannot adopt', () => {
    // Two live services under one prefix is worth saying even when nothing can be done automatically.
    const claim = claimService('github-mcp', tree({ projectIds: ['p-mine'] }), [owner(), tree()]);
    expect(claimNotice('github-mcp', claim)).toMatch(/share the prefix on every tool/);
  });

  it('handles an owner tree that has no project yet', () => {
    // Nothing to adopt, but the names still collide.
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
  const route = readFileSync(join(here, '../index.ts'), 'utf8');

  it('attaches the adopted project to the tree', () => {
    // Attaching is the whole point: resolveLeafProject reads projectIds[0], not prose.
    expect(route).toMatch(/withProject\(\{ \.\.\.tree, serviceName: declaredName, updatedAt: now \}, claim\.adoptProjectId\)/);
  });

  it('posts the notice to the branch', () => {
    expect(route).toMatch(/const text = claimNotice\(declaredName, claim\)/);
  });

  it('only claims against this user\'s trees', () => {
    expect(route).toMatch(/claimService\(declaredName, tree, await ownedTrees\(/);
  });
});

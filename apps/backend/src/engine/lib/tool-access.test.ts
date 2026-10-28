import { describe, expect, it } from 'vitest';
import { BUILDER_TOOLS } from '@koala/agent-engine';
import { INSTALLED_EXTENSIONS } from '../../extensions/installed.js';
import { asPerson, rolePrincipal, ruleFor, type Actions, type Principal } from '../../platform/lib/permissions.js';
import { accessOf, accessProblem, offerable, OWN_TOOL_ACCESS, resourceFor, TOOL_ACCESS } from './tool-access.js';

const owner: Principal = { kind: 'person', id: 'owner', claims: [{ role: 'person' }, { role: 'operator' }] };
const client = rolePrincipal('cy', 'p1', 'client');
const collaborator = rolePrincipal('cy', 'p1', 'collaborator');
const asker = { email: 'cy@example.com', role: 'client' };
const shared = { project: { id: 'p1', ownerId: 'owner' } };

describe('what every tool declares it needs', () => {
  it('covers every tool the platform ships, so a new one is refused to everyone but its owner until it says what it reaches', () => {
    const shipped = [...INSTALLED_EXTENSIONS.flatMap((extension) => (extension.tools ?? []).map((tool) => tool.name)), ...BUILDER_TOOLS.map((tool) => tool.name)];
    expect(shipped.filter((name) => TOOL_ACCESS[name] === undefined)).toEqual([]);
    expect(accessOf('a_tool_nobody_classified', undefined, false)).toEqual(OWN_TOOL_ACCESS);
    expect(offerable(OWN_TOOL_ACCESS, client, 'owner', 'p1')).toBe(false);
  });

  it('names an action the permissions table has a row for', () => {
    for (const [name, access] of Object.entries(TOOL_ACCESS)) {
      const target = resourceFor(access, 'owner', {}, {});
      if (!target || 'outside' in target) continue;
      expect(ruleFor(target.resource.kind, target.action as Actions[typeof target.resource.kind]), name).toBeDefined();
    }
  });

  it('reads an MCP tool as seeing the project and a writing one as changing it', () => {
    expect(accessOf('shop__list', { effect: 'read' }, true)).toEqual({ on: 'project', action: 'see' });
    expect(accessOf('shop__delete', { effect: 'write' }, true)).toEqual({ on: 'project', action: 'change' });
  });
});

describe('what a call is refused', () => {
  it('lets the owner do everything, and a member only what their role allows in their project', () => {
    expect(accessProblem('save_memory', TOOL_ACCESS.save_memory!, owner, 'owner', {}, {})).toBeUndefined();
    expect(accessProblem('list_infrastructure', TOOL_ACCESS.list_infrastructure!, owner, 'owner', {}, {})).toBeUndefined();
    expect(accessProblem('get_project_url', TOOL_ACCESS.get_project_url!, client, 'owner', {}, shared)).toBeUndefined();
    expect(accessProblem('get_project_url', TOOL_ACCESS.get_project_url!, client, 'owner', { projectId: 'p2' }, { project: { id: 'p2', ownerId: 'owner' } }, asker))
      .toBe('Koala is answering cy@example.com, a client on this shared project, so get_project_url may not be given that projectId: it names something outside this shared project.');
    expect(accessProblem('list_infrastructure', TOOL_ACCESS.list_infrastructure!, client, 'owner', {}, {}, asker))
      .toBe('Koala is answering cy@example.com, a client on this shared project, so it may not use list_infrastructure, which reaches beyond the project.');
    expect(accessProblem('save_memory', TOOL_ACCESS.save_memory!, client, 'owner', {}, {}, asker)).toMatch(/may not use save_memory, which reaches beyond the project/);
    expect(accessProblem('mark_done', TOOL_ACCESS.mark_done!, client, 'owner', { taskId: 'k1' }, shared, asker))
      .toBe('Koala is answering cy@example.com, a client on this shared project, so it may not use mark_done here: Only an owner or a collaborator can change this project.');
    expect(accessProblem('mark_done', TOOL_ACCESS.mark_done!, collaborator, 'owner', { taskId: 'k1' }, shared, asker)).toBeUndefined();
    expect(accessProblem('list_project_secrets', TOOL_ACCESS.list_project_secrets!, collaborator, 'owner', {}, shared, asker)).toMatch(/Only an owner can see this project's secrets/);
    expect(accessProblem('request_cluster_access', TOOL_ACCESS.request_cluster_access!, asPerson('owner'), 'owner', {}, {})).toMatch(/Only the operator/);
    expect(accessProblem('search_web', TOOL_ACCESS.search_web!, client, 'owner', {}, {}, asker)).toBeUndefined();
  });

  it('keeps a new tree and a tree type change the owner\'s, and a project no one can resolve the owner\'s', () => {
    expect(accessProblem('propose_plan', TOOL_ACCESS.propose_plan!, collaborator, 'owner', { treeId: 't1' }, shared, asker)).toBeUndefined();
    expect(accessProblem('propose_plan', TOOL_ACCESS.propose_plan!, collaborator, 'owner', { tree: { name: 'New' } }, shared, asker)).toMatch(/reaches beyond the project/);
    expect(accessProblem('propose_release_change', TOOL_ACCESS.propose_release_change!, collaborator, 'owner', { treeType: 'odoo' }, shared, asker)).toMatch(/reaches beyond the project/);
    expect(accessProblem('get_project_url', TOOL_ACCESS.get_project_url!, collaborator, 'owner', {}, {}, asker)).toMatch(/reaches beyond the project/);
    expect(accessProblem('get_project_url', TOOL_ACCESS.get_project_url!, owner, 'owner', {}, {})).toBeUndefined();
  });

  it('names nothing outside the project in a refusal', () => {
    const refusal = accessProblem('read_tree', TOOL_ACCESS.read_tree!, client, 'owner', { treeId: 'secret-tree' }, { outside: 'treeId' }, asker)!;
    expect(refusal).not.toMatch(/secret-tree/);
  });
});

describe('what is offered', () => {
  it('leaves out what the principal could never use', () => {
    expect(offerable(TOOL_ACCESS.save_memory!, owner, 'owner')).toBe(true);
    expect(offerable(TOOL_ACCESS.save_memory!, client, 'owner', 'p1')).toBe(false);
    expect(offerable(TOOL_ACCESS.get_project_url!, client, 'owner', 'p1')).toBe(true);
    expect(offerable(TOOL_ACCESS.mark_done!, client, 'owner', 'p1')).toBe(false);
    expect(offerable(TOOL_ACCESS.mark_done!, collaborator, 'owner', 'p1')).toBe(true);
    expect(offerable(TOOL_ACCESS.search_web!, client, 'owner', 'p1')).toBe(true);
    expect(offerable(TOOL_ACCESS.request_cluster_access!, asPerson('owner'), 'owner')).toBe(false);
    expect(offerable(TOOL_ACCESS.request_cluster_access!, owner, 'owner')).toBe(true);
  });
});

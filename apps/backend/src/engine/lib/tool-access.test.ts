import { describe, expect, it } from 'vitest';
import { BUILDER_TOOLS } from '@koala/agent-engine';
import { INSTALLED_EXTENSIONS } from '../../extensions/installed.js';
import { asPerson, ruleFor, type Actions, type Principal } from '../../platform/lib/permissions.js';
import { accessOf, accessProblem, offerable, OWN_TOOL_ACCESS, resourceFor, sourceOf, TOOL_ACCESS, TOOL_SOURCES } from './tool-access.js';

const owner: Principal = { kind: 'person', id: 'owner', claims: [{ role: 'person' }, { role: 'operator' }] };
const someoneElse = asPerson('cy');
const theirs = { project: { id: 'p1', ownerId: 'owner' } };

describe('what every tool declares it needs', () => {
  it('covers every tool the platform ships, so a new one is refused to everyone but its owner until it says what it reaches', () => {
    const shipped = [...INSTALLED_EXTENSIONS.flatMap((extension) => (extension.tools ?? []).map((tool) => tool.name)), ...BUILDER_TOOLS.map((tool) => tool.name)];
    expect(shipped.filter((name) => TOOL_ACCESS[name] === undefined)).toEqual([]);
    expect(accessOf('a_tool_nobody_classified', undefined, false)).toEqual(OWN_TOOL_ACCESS);
    expect(offerable(OWN_TOOL_ACCESS, someoneElse, 'owner', 'p1')).toBe(false);
  });

  it('says where every shipped tool\'s result comes from, beside what it reaches', () => {
    const shipped = [...INSTALLED_EXTENSIONS.flatMap((extension) => (extension.tools ?? []).map((tool) => tool.name)), ...BUILDER_TOOLS.map((tool) => tool.name)];
    expect(shipped.filter((name) => TOOL_SOURCES[name] === undefined)).toEqual([]);
    expect(Object.keys(TOOL_ACCESS).filter((name) => TOOL_SOURCES[name] === undefined)).toEqual([]);
    expect(Object.keys(TOOL_SOURCES).filter((name) => TOOL_ACCESS[name] === undefined)).toEqual([]);
    expect(sourceOf('github__get_issue', true)).toBe('mcp');
    expect(sourceOf('research', false)).toBe('agent');
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
  it('lets the owner do everything, and refuses someone else what is the owner\'s', () => {
    expect(accessProblem('save_memory', TOOL_ACCESS.save_memory!, owner, 'owner', {}, {})).toBeUndefined();
    expect(accessProblem('list_infrastructure', TOOL_ACCESS.list_infrastructure!, owner, 'owner', {}, {})).toBeUndefined();
    expect(accessProblem('get_project_url', TOOL_ACCESS.get_project_url!, owner, 'owner', {}, theirs)).toBeUndefined();
    expect(accessProblem('mark_done', TOOL_ACCESS.mark_done!, someoneElse, 'owner', { taskId: 'k1' }, theirs)).toBe('mark_done was not run: Only the owner can change this project.');
    expect(accessProblem('request_cluster_access', TOOL_ACCESS.request_cluster_access!, asPerson('owner'), 'owner', {}, {})).toMatch(/Only the operator/);
    expect(accessProblem('search_web', TOOL_ACCESS.search_web!, someoneElse, 'owner', {}, {})).toBeUndefined();
  });

  it('takes a project no one can resolve as the owner\'s, and names nothing outside it in a refusal', () => {
    expect(accessProblem('get_project_url', TOOL_ACCESS.get_project_url!, owner, 'owner', {}, {})).toBeUndefined();
    const refusal = accessProblem('read_tree', TOOL_ACCESS.read_tree!, owner, 'owner', { treeId: 'secret-tree' }, { outside: 'treeId' })!;
    expect(refusal).toBe('read_tree may not be given that treeId: it names nothing of yours.');
  });
});

describe('what is offered', () => {
  it('leaves out what the principal could never use', () => {
    expect(offerable(TOOL_ACCESS.save_memory!, owner, 'owner')).toBe(true);
    expect(offerable(TOOL_ACCESS.save_memory!, someoneElse, 'owner', 'p1')).toBe(false);
    expect(offerable(TOOL_ACCESS.mark_done!, someoneElse, 'owner', 'p1')).toBe(false);
    expect(offerable(TOOL_ACCESS.search_web!, someoneElse, 'owner', 'p1')).toBe(true);
    expect(offerable(TOOL_ACCESS.request_cluster_access!, asPerson('owner'), 'owner')).toBe(false);
    expect(offerable(TOOL_ACCESS.request_cluster_access!, owner, 'owner')).toBe(true);
  });
});

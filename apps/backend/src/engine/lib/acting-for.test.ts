import { describe, expect, it } from 'vitest';
import { BUILDER_TOOLS } from '@koala/agent-engine';
import { INSTALLED_EXTENSIONS } from '../../extensions/installed.js';
import { heldBackFromOthers, keptToProblem, MEMBER_REACH, memberCallProblem, memberScopeOf, offeredToMember } from './acting-for.js';

const client = { email: 'cy@example.com', role: 'client' };

const scope = memberScopeOf('p1', {
  projects: [{ id: 'p1', name: 'Shop', giteaRepo: 'shop-repo' }, { id: 'p2', name: 'Secret Plans' }],
  trees: [{ id: 't1', projectIds: ['p1'] }, { id: 't2', projectIds: ['p2'] }],
  branches: [{ id: 'b1', treeId: 't1' }, { id: 'b2', treeId: 't2' }],
  leaves: [{ id: 'l1', branchId: 'b1' }, { id: 'l2', branchId: 'b2' }],
  tasks: [{ id: 'k1', leafId: 'l1' }, { id: 'k2', leafId: 'l2' }, { id: 'k3', projectId: 'p1' }],
});

describe('what Koala may do for a member of a shared project', () => {
  it('has decided every tool the platform ships, so a new one is refused to members until it is', () => {
    const shipped = [...INSTALLED_EXTENSIONS.flatMap((extension) => (extension.tools ?? []).map((tool) => tool.name)), ...BUILDER_TOOLS.map((tool) => tool.name)];
    expect(shipped.filter((name) => MEMBER_REACH[name] === undefined)).toEqual([]);
    expect(memberCallProblem('a_tool_nobody_classified', {}, scope, client)).toMatch(/may not use a_tool_nobody_classified/);
    expect(offeredToMember('a_tool_nobody_classified')).toBe(false);
  });

  it('holds back everything outside the project: clusters, checks, procedures, memory, other agents\' runs', () => {
    for (const tool of ['list_infrastructure', 'get_logs', 'write_check', 'save_procedure', 'save_memory', 'search_memories', 'read_run', 'propose_deploy_app', 'list_tree_types']) {
      expect(memberCallProblem(tool, {}, scope, client), tool).toBe(`Koala is answering cy@example.com, a client on this shared project, so it may not use ${tool}, which reaches beyond the project.`);
      expect(offeredToMember(tool), tool).toBe(false);
    }
  });

  it('lets everything in the project through, and nothing that names another project or its work', () => {
    expect(memberCallProblem('read_tree', {}, scope, client)).toBeUndefined();
    expect(memberCallProblem('read_tree', { treeId: 't1' }, scope, client)).toBeUndefined();
    expect(memberCallProblem('list_files', { project: 'shop' }, scope, client)).toBeUndefined();
    expect(memberCallProblem('list_files', { project: 'SHOP-REPO' }, scope, client)).toBeUndefined();
    expect(memberCallProblem('list_project_secrets', { projectId: 'p1' }, scope, client)).toBeUndefined();
    expect(memberCallProblem('mark_done', { taskId: 'k3' }, scope, client)).toBeUndefined();
    expect(memberCallProblem('propose_story_cancel', { leafIds: ['l1'] }, scope, client)).toBeUndefined();

    expect(memberCallProblem('read_tree', { treeId: 't2' }, scope, client)).toMatch(/may not be given that treeId: it names something outside this shared project/);
    expect(memberCallProblem('list_files', { project: 'Secret Plans' }, scope, client)).toMatch(/that project:/);
    expect(memberCallProblem('list_project_secrets', { projectId: 'p2' }, scope, client)).toMatch(/that projectId:/);
    expect(memberCallProblem('mark_done', { taskId: 'k2' }, scope, client)).toMatch(/that taskId:/);
    expect(memberCallProblem('propose_story_cancel', { leafIds: ['l1', 'l2'] }, scope, client)).toMatch(/that leafIds:/);
    expect(memberCallProblem('propose_stories', { branchId: 'b2' }, scope, client)).toMatch(/that branchId:/);
    for (const refusal of [memberCallProblem('list_files', { project: 'Secret Plans' }, scope, client), memberCallProblem('read_tree', { treeId: 't2' }, scope, client)]) {
      expect(refusal).not.toMatch(/Secret Plans|t2|p2/);
    }
  });

  it('never plans a new tree, changes a tree type, or lists every task the owner has', () => {
    expect(memberCallProblem('propose_plan', { treeId: 't1' }, scope, client)).toBeUndefined();
    expect(memberCallProblem('propose_plan', { tree: { name: 'New' } }, scope, client)).toMatch(/may not be given tree/);
    expect(memberCallProblem('propose_plan', {}, scope, client)).toMatch(/needs treeId/);
    expect(memberCallProblem('propose_release_change', { project: 'p1', treeType: 'odoo' }, scope, client)).toMatch(/may not be given treeType/);
    expect(memberCallProblem('list_tasks', {}, scope, client)).toMatch(/needs leafId/);
    expect(memberCallProblem('list_tasks', { leafId: 'l1' }, scope, client)).toBeUndefined();
  });

  it('treats an MCP server\'s tool as any other tool the agent holds', () => {
    expect(memberCallProblem('playwright__browser_navigate', { url: 'x' }, scope, client, true)).toBeUndefined();
    expect(offeredToMember('playwright__browser_navigate', true)).toBe(true);
  });
});

describe('what the memory keeper does with a conversation others talked in', () => {
  it('keeps only project memories, replaces and forgets nothing, and proposes nothing', () => {
    expect(keptToProblem('save_memory', { title: 'x', text: 'y' })).toBeUndefined();
    expect(keptToProblem('save_memory', { title: 'x', text: 'y', scope: 'project' })).toBeUndefined();
    expect(keptToProblem('save_memory', { title: 'x', text: 'y', scope: 'global' })).toMatch(/never global/);
    expect(keptToProblem('save_memory', { title: 'x', text: 'y', replaces: 'm1' })).toMatch(/replaces nothing/);
    for (const tool of ['forget_memory', 'propose_practice', 'propose_prompt_change', 'propose_scenario', 'propose_tool_note', 'request_procedure_change']) {
      expect(keptToProblem(tool, {}), tool).toMatch(/people other than the owner/);
      expect(heldBackFromOthers(tool)).toBe(true);
    }
    expect(keptToProblem('search_memories', { query: 'x' })).toBeUndefined();
  });
});

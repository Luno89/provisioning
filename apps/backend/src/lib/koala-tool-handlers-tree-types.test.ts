import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryDB } from './memory-db.js';
import { seedAll } from '../scripts/seed-all.js';
import {
  handleGetTreeType, handleCreateTreeType, handleSetTreeTypeOverview,
  handleSetTreeTypeScaffoldFile, handleDeleteTreeTypeScaffoldFile,
  handleAddValidationStep, handleAddValidationGroup, handleAddValidationLoop,
  handleReviseValidationStep, handleRemoveValidationStep, handleReorderValidationSteps,
  handleSetTreeTypeBindings, handleSetTreeTypeRoles, handleSetTreeTypeAutoAccept, handleSetTreeTypeVerdictPolicy, handleDeleteTreeType,
  type KoalaToolContext,
} from './koala-tool-handlers.js';

let db: MemoryDB;
const userId = 'u1';

const ctx = (): KoalaToolContext => ({ db, userId } as unknown as KoalaToolContext);
const body = (out: { content: string }) => JSON.parse(out.content);

beforeEach(async () => {
  db = new MemoryDB();
  await db.init();
  await seedAll(db as never);
});

async function createType(id = 'widget') {
  const out = await handleCreateTreeType(ctx(), {
    id, label: 'Widget', summary: 'A widget.', doneMeans: 'It works.', language: 'node', produces: 'service',
  });
  expect(body(out).created).toBeDefined();
  return id;
}

describe('create_tree_type', () => {
  it('creates a new type with just the required fields', async () => {
    const id = await createType();
    const out = await handleGetTreeType(ctx(), { id });
    expect(body(out).treeType).toMatchObject({ id, label: 'Widget', ownerId: userId });
  });

  it('refuses when a required field is missing', async () => {
    const out = await handleCreateTreeType(ctx(), { id: 'x', label: 'X' });
    expect(body(out).error).toMatch(/required/i);
  });

  it('refuses an unknown language', async () => {
    const out = await handleCreateTreeType(ctx(), {
      id: 'x', label: 'X', summary: 's', doneMeans: 'd', language: 'cobol', produces: 'service',
    });
    expect(body(out).error).toMatch(/language/i);
  });
});

describe('get_tree_type', () => {
  it('resolves a shipped type by id', async () => {
    const out = await handleGetTreeType(ctx(), { id: 'api-service' });
    expect(body(out).treeType.id).toBe('api-service');
  });

  it('reports available types when the id does not exist', async () => {
    const out = await handleGetTreeType(ctx(), { id: 'ghost' });
    expect(body(out).error).toMatch(/no tree type/i);
    expect(Array.isArray(body(out).available)).toBe(true);
  });
});

describe('set_tree_type_overview', () => {
  it('patches only the given fields, creating an owned override of a shipped type', async () => {
    const out = await handleSetTreeTypeOverview(ctx(), { id: 'api-service', summary: 'Revised summary.' });
    expect(body(out).updated.id).toBe('api-service');

    const got = body(await handleGetTreeType(ctx(), { id: 'api-service' }));
    expect(got.treeType.summary).toBe('Revised summary.');
    expect(got.treeType.ownerId).toBe(userId);
    expect(got.treeType.label).toBeTruthy();
  });

  it('refuses with nothing to change', async () => {
    const id = await createType();
    const out = await handleSetTreeTypeOverview(ctx(), { id });
    expect(body(out).error).toMatch(/nothing to change/i);
  });
});

describe('scaffold files', () => {
  it('adds and then updates a file at the same path', async () => {
    const id = await createType();
    await handleSetTreeTypeScaffoldFile(ctx(), { id, path: 'README.md', content: '# hi' });
    const first = body(await handleGetTreeType(ctx(), { id }));
    expect(first.treeType.files).toEqual([{ path: 'README.md', content: '# hi' }]);

    await handleSetTreeTypeScaffoldFile(ctx(), { id, path: 'README.md', content: '# updated', executable: true });
    const second = body(await handleGetTreeType(ctx(), { id }));
    expect(second.treeType.files).toEqual([{ path: 'README.md', content: '# updated', executable: true }]);
  });

  it('refuses an escaping path', async () => {
    const id = await createType();
    const out = await handleSetTreeTypeScaffoldFile(ctx(), { id, path: '../outside.md', content: 'x' });
    expect(body(out).error).toMatch(/path/i);
  });

  it('removes a file by path', async () => {
    const id = await createType();
    await handleSetTreeTypeScaffoldFile(ctx(), { id, path: 'a.txt', content: 'a' });
    const out = await handleDeleteTreeTypeScaffoldFile(ctx(), { id, path: 'a.txt' });
    expect(body(out).updated.files).toEqual([]);
  });

  it('reports an error deleting a path that is not there', async () => {
    const id = await createType();
    const out = await handleDeleteTreeTypeScaffoldFile(ctx(), { id, path: 'ghost.txt' });
    expect(body(out).error).toMatch(/no scaffold file/i);
  });
});

describe('validation recipe authoring', () => {
  it('adds a step at the top level', async () => {
    const id = await createType();
    const out = await handleAddValidationStep(ctx(), { id, name: 'README exists', type: 'file-exists', target: 'README.md' });
    const stepId = body(out).added.id;

    const got = body(await handleGetTreeType(ctx(), { id }));
    expect(got.treeType.validationRecipe.checks).toHaveLength(1);
    expect(got.treeType.validationRecipe.checks[0]).toMatchObject({ id: stepId, name: 'README exists', type: 'file-exists', target: 'README.md' });
  });

  it('refuses run-command — a chat assistant must not author raw shell commands', async () => {
    const id = await createType();
    const out = await handleAddValidationStep(ctx(), { id, name: 'Run tests', type: 'run-command' });
    expect(body(out).error).toMatch(/run-command/i);

    const got = body(await handleGetTreeType(ctx(), { id }));
    expect(got.treeType.validationRecipe).toBeUndefined();
  });

  it('refuses a wait-for wrapping run-command', async () => {
    const id = await createType();
    const out = await handleAddValidationStep(ctx(), { id, name: 'Wait', type: 'wait-for', waitForType: 'run-command' });
    expect(body(out).error).toMatch(/run-command/i);
  });

  it('never accepts a command parameter at all', async () => {
    const id = await createType();
    const out = await handleAddValidationStep(ctx(), { id, name: 'x', type: 'file-exists', target: 'a', command: 'rm -rf /' });
    const stepId = body(out).added.id;
    const got = body(await handleGetTreeType(ctx(), { id }));
    expect(got.treeType.validationRecipe.checks[0].command).toBeUndefined();
    expect(stepId).toBeTruthy();
  });

  it('adds a group, then a step nested inside it', async () => {
    const id = await createType();
    const groupOut = await handleAddValidationGroup(ctx(), { id, name: 'Checks' });
    const groupId = body(groupOut).added.id;

    await handleAddValidationStep(ctx(), { id, parentId: groupId, name: 'README exists', type: 'file-exists', target: 'README.md' });

    const got = body(await handleGetTreeType(ctx(), { id }));
    expect(got.treeType.validationRecipe.checks).toHaveLength(1);
    expect(got.treeType.validationRecipe.checks[0].children).toHaveLength(1);
    expect(got.treeType.validationRecipe.checks[0].children[0].name).toBe('README exists');
  });

  it('adds a count loop requiring maxIterations', async () => {
    const id = await createType();
    const missing = await handleAddValidationLoop(ctx(), { id, name: 'Loop', loopType: 'count' });
    expect(body(missing).error).toMatch(/maxIterations/i);

    const ok = await handleAddValidationLoop(ctx(), { id, name: 'Loop', loopType: 'count', maxIterations: 3 });
    expect(body(ok).added).toBeDefined();
  });

  it('refuses adding into a parentId that does not exist', async () => {
    const id = await createType();
    const out = await handleAddValidationStep(ctx(), { id, parentId: 'ghost', name: 'x', type: 'file-exists', target: 'a' });
    expect(body(out).error).toMatch(/no step, group, or loop/i);
  });

  it('refuses adding into a leaf step as if it were a container', async () => {
    const id = await createType();
    const stepOut = await handleAddValidationStep(ctx(), { id, name: 'A', type: 'file-exists', target: 'a' });
    const stepId = body(stepOut).added.id;

    const out = await handleAddValidationStep(ctx(), { id, parentId: stepId, name: 'B', type: 'file-exists', target: 'b' });
    expect(body(out).error).toMatch(/not a group or loop/i);
  });

  it('revises a step\'s fields, and refuses changing it to run-command', async () => {
    const id = await createType();
    const stepOut = await handleAddValidationStep(ctx(), { id, name: 'A', type: 'file-exists', target: 'a' });
    const stepId = body(stepOut).added.id;

    await handleReviseValidationStep(ctx(), { id, stepId, name: 'A renamed', optional: true });
    const got = body(await handleGetTreeType(ctx(), { id }));
    expect(got.treeType.validationRecipe.checks[0]).toMatchObject({ name: 'A renamed', optional: true });

    const refused = await handleReviseValidationStep(ctx(), { id, stepId, type: 'run-command' });
    expect(body(refused).error).toMatch(/run-command/i);
  });

  it('revises a loop\'s loopType and its conditional fields', async () => {
    const id = await createType();
    const loopOut = await handleAddValidationLoop(ctx(), { id, name: 'Loop', loopType: 'count', maxIterations: 3 });
    const loopId = body(loopOut).added.id;

    await handleReviseValidationStep(ctx(), { id, stepId: loopId, loopType: 'forEach', itemsCommand: 'ls' });
    const got = body(await handleGetTreeType(ctx(), { id }));
    expect(got.treeType.validationRecipe.checks[0]).toMatchObject({ loopType: 'forEach', itemsCommand: 'ls' });
  });

  it('removes a step and clears a dangling runIf reference to it', async () => {
    const id = await createType();
    const aOut = await handleAddValidationStep(ctx(), { id, name: 'A', type: 'file-exists', target: 'a' });
    const aId = body(aOut).added.id;
    const bOut = await handleAddValidationStep(ctx(), { id, name: 'B', type: 'file-exists', target: 'b', runIf: aId });
    const bId = body(bOut).added.id;

    await handleRemoveValidationStep(ctx(), { id, stepId: aId });

    const got = body(await handleGetTreeType(ctx(), { id }));
    expect(got.treeType.validationRecipe.checks).toHaveLength(1);
    expect(got.treeType.validationRecipe.checks[0].id).toBe(bId);
    expect(got.treeType.validationRecipe.checks[0].runIf).toBeUndefined();
  });

  it('reorders steps at the top level', async () => {
    const id = await createType();
    const aId = body(await handleAddValidationStep(ctx(), { id, name: 'A', type: 'file-exists', target: 'a' })).added.id;
    const bId = body(await handleAddValidationStep(ctx(), { id, name: 'B', type: 'file-exists', target: 'b' })).added.id;

    await handleReorderValidationSteps(ctx(), { id, orderedStepIds: [bId, aId] });
    const got = body(await handleGetTreeType(ctx(), { id }));
    expect(got.treeType.validationRecipe.checks.map((c: { id: string }) => c.id)).toEqual([bId, aId]);
  });

  it('refuses a reorder list that does not name exactly the current ids', async () => {
    const id = await createType();
    const aId = body(await handleAddValidationStep(ctx(), { id, name: 'A', type: 'file-exists', target: 'a' })).added.id;
    await handleAddValidationStep(ctx(), { id, name: 'B', type: 'file-exists', target: 'b' });

    const out = await handleReorderValidationSteps(ctx(), { id, orderedStepIds: [aId] });
    expect(body(out).error).toMatch(/orderedStepIds/i);
  });
});

describe('set_tree_type_bindings', () => {
  it('replaces defaultBindings entirely', async () => {
    const id = await createType();
    await handleSetTreeTypeBindings(ctx(), { id, defaultBindings: ['gitea', 'registry'] });
    const got = body(await handleGetTreeType(ctx(), { id }));
    expect(got.treeType.defaultBindings).toEqual(['gitea', 'registry']);
  });
});

describe('set_tree_type_roles', () => {
  it('sets a role to an existing pack', async () => {
    const id = await createType();
    const out = await handleSetTreeTypeRoles(ctx(), { id, role: 'planner', packSlug: 'koala' });
    expect(body(out).updated).toMatchObject({ role: 'planner', packSlug: 'koala' });
  });

  it('refuses an unknown role', async () => {
    const id = await createType();
    const out = await handleSetTreeTypeRoles(ctx(), { id, role: 'ghost', packSlug: 'koala' });
    expect(body(out).error).toMatch(/role/i);
  });

  it('refuses an unknown pack', async () => {
    const id = await createType();
    const out = await handleSetTreeTypeRoles(ctx(), { id, role: 'planner', packSlug: 'ghost' });
    expect(body(out).error).toMatch(/no pack/i);
  });
});

describe('set_tree_type_auto_accept', () => {
  it('patches given fields, leaving others alone', async () => {
    const id = await createType();
    await handleSetTreeTypeAutoAccept(ctx(), { id, enabled: true, max: 5 });
    const got = body(await handleGetTreeType(ctx(), { id }));
    expect(got.treeType.autoAccept).toMatchObject({ enabled: true, max: 5 });
  });
});

describe('set_tree_type_verdict_policy', () => {
  it('patches given fields, leaving others alone', async () => {
    const id = await createType();
    await handleSetTreeTypeVerdictPolicy(ctx(), { id, requireVerify: true, combineMode: 'all' });
    const got = body(await handleGetTreeType(ctx(), { id }));
    expect(got.treeType.verdictPolicy).toMatchObject({ requireVerify: true, combineMode: 'all' });
  });

  it('a later call only changes the fields it names', async () => {
    const id = await createType();
    await handleSetTreeTypeVerdictPolicy(ctx(), { id, requireVerify: true, requireArtifacts: true });
    await handleSetTreeTypeVerdictPolicy(ctx(), { id, combineMode: 'all' });
    const got = body(await handleGetTreeType(ctx(), { id }));
    expect(got.treeType.verdictPolicy).toMatchObject({ requireVerify: true, requireArtifacts: true, combineMode: 'all' });
  });

  it('ignores a combineMode value outside all/any rather than saving it', async () => {
    const id = await createType();
    const out = await handleSetTreeTypeVerdictPolicy(ctx(), { id, combineMode: 'sometimes' });
    const got = body(await handleGetTreeType(ctx(), { id }));
    expect(body(out).updated).toBeDefined();
    expect(got.treeType.verdictPolicy?.combineMode).toBeUndefined();
  });
});

describe('delete_tree_type', () => {
  it('deletes an owned type', async () => {
    const id = await createType();
    const out = await handleDeleteTreeType(ctx(), { id });
    expect(body(out).deleted).toBe(id);
    expect(body(await handleGetTreeType(ctx(), { id })).error).toBeDefined();
  });

  it('refuses to delete a built-in type with no owned override', async () => {
    const out = await handleDeleteTreeType(ctx(), { id: 'api-service' });
    expect(body(out).error).toMatch(/built-in/i);
  });

  it('refuses while a tree still uses this type', async () => {
    const id = await createType();
    await db.saveTree({ id: 't1', name: 'My tree', type: id, ownerId: userId, branchCount: 0, updatedAt: '' } as never);
    const out = await handleDeleteTreeType(ctx(), { id });
    expect(body(out).error).toMatch(/still use this type/i);
  });
});

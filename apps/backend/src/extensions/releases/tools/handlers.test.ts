import { describe, it, expect, beforeEach } from 'vitest';
import type { ToolOutcome } from '@koala/engine-core';
import { createReleaseTools } from './handlers.js';
import type { ActionProposal } from '../../../lib/action-proposals.js';

let saved: ActionProposal[];
const tools = () => createReleaseTools({
  problem: async (_owner, how) => ((how as { agent: string }).agent === 'koala' ? 'koala is not an agent that releases builds' : null),
  treeTypes: async () => [{ id: 'odoo-addons', label: 'Odoo addons' }],
  projects: async () => [{ id: 'p1', name: 'Shop' }],
  proposals: { list: async () => saved, save: async (proposal) => { saved.push(proposal); } },
  now: () => 't',
  newId: () => `a${saved.length + 1}`,
});
const propose = (parsed: Record<string, unknown>, ownerId = 'bo') =>
  tools().propose_release_change!({ name: 'propose_release_change', parsed, caller: { ownerId, runId: 'run-1', conversationId: 'c1' } } as never) as Promise<ToolOutcome>;

beforeEach(() => { saved = []; });

describe('Koala proposing how builds are released', () => {
  it('puts a change to a tree type\'s release on a card, and changes nothing itself', async () => {
    const outcome = await propose({ treeType: 'odoo-addons', agent: 'release-replace', why: 'the person wants no previews' });
    expect(outcome).toMatchObject({ ok: true, digest: 'proposed: Release Odoo addons (every project of this tree type) with the release-replace agent' });
    expect(saved).toEqual([expect.objectContaining({ kind: 'set_release', status: 'proposed', why: 'the person wants no previews', conversationId: 'c1', params: { target: 'treeType', id: 'odoo-addons', agent: 'release-replace' } })]);
  });

  it('proposes one project going back to its type\'s release, and does not propose the same card twice', async () => {
    expect(await propose({ project: 'p1', clear: true, why: 'back to normal' })).toMatchObject({ ok: true, digest: 'proposed: Release Shop the way its tree type does' });
    expect(await propose({ project: 'p1', clear: true, why: 'again' })).toMatchObject({ ok: true, digest: 'already proposed: Release Shop the way its tree type does' });
    expect(saved).toHaveLength(1);
    expect(saved[0]!.params).toEqual({ target: 'project', id: 'p1', clear: 'true' });
  });

  it('refuses what it cannot propose, saying why', async () => {
    expect(await propose({ project: 'p1', agent: 'koala', why: 'w' })).toMatchObject({ ok: false, content: 'koala is not an agent that releases builds; nothing was proposed' });
    expect(await propose({ project: 'p1', treeType: 'odoo-addons', agent: 'release', app: 'odoo', why: 'w' })).toMatchObject({ ok: false, content: 'name either a tree type or a project, not both and not neither' });
    expect(await propose({ project: 'nope', agent: 'release', app: 'odoo', why: 'w' })).toMatchObject({ ok: false, content: 'there is no project nope' });
    expect(await propose({ project: 'p1', agent: 'release', app: 'odoo' })).toMatchObject({ ok: false, content: 'say why, for the person to read on the card' });
    expect(saved).toEqual([]);
  });
});

describe('customizations made in the live app', () => {
  const written: Record<string, string> = {};
  const customizations = {
    drift: async (_owner: string, projectId: string) => (projectId === 'p1'
      ? { ok: true as const, value: { projectId, project: 'Shop', module: 'shop_customizations', items: [{ kind: 'field', key: 'koala.probe.x_note', name: 'The field Note (x_note) on koala.probe, made in the app,', fingerprint: 'f', active: true }] } }
      : { ok: false as const, status: 404 as const, error: 'You have no project with that id' }),
    propose: async () => ({ ok: true as const, value: { id: 'card-1', change: { add: { leaves: [{ title: 'Bring 1 customization made in the app into git' }] } } } as never }),
    exportItems: async (_owner: string, _project: string, refs: readonly string[]) => (refs.includes('field/bad')
      ? { ok: true as const, value: { module: 'shop_customizations', files: [], refused: [{ key: 'bad', why: 'its model_id points at a ir.model record (id 9) that has no XML id to name it by' }] } }
      : { ok: true as const, value: { module: 'shop_customizations', files: [{ path: 'addons/shop_customizations/__manifest__.py', content: "{'name': 'x'}" }], refused: [] } }),
  };
  const made = () => createReleaseTools({ problem: async () => null, treeTypes: async () => [], projects: async () => [], proposals: { list: async () => [], save: async () => undefined }, customizations, projectOfTree: async () => 'p1' });
  const driver = { writeFile: async (path: string, content: string) => { written[path] = content; } } as never;

  it('lists them for Koala by ref, finding the project from the tree a run works in', async () => {
    const outcome = await made().app_drift!({ name: 'app_drift', parsed: {}, caller: { ownerId: 'bo', treeId: 't1' }, driver: undefined } as never);
    expect(outcome.content).toContain('- The field Note (x_note) on koala.probe, made in the app (field; ref field/koala.probe.x_note)');
    expect(outcome.content).toContain('addons/shop_customizations');
  });

  it('proposes bringing them in on a card', async () => {
    expect(await made().propose_adopt_customizations!({ name: 'propose_adopt_customizations', parsed: { project: 'p1', why: 'keep them' }, caller: { ownerId: 'bo', conversationId: 'c1' }, driver: undefined } as never))
      .toMatchObject({ ok: true, content: 'Proposed on a card: "Bring 1 customization made in the app into git". Approving it adds the story to the project\'s tree and runs it; nothing changes until the person approves.' });
  });

  it('writes the exported files into the run\'s workspace, and writes nothing when anything is refused', async () => {
    const outcome = await made().export_customizations!({ name: 'export_customizations', parsed: { refs: ['field/koala.probe.x_note'] }, caller: { ownerId: 'bo', treeId: 't1' }, driver } as never);
    expect(outcome).toMatchObject({ ok: true, digest: 'wrote 1 files into addons/shop_customizations' });
    expect(written['addons/shop_customizations/__manifest__.py']).toBe("{'name': 'x'}");
    const refused = await made().export_customizations!({ name: 'export_customizations', parsed: { refs: ['field/bad'] }, caller: { ownerId: 'bo', treeId: 't1' }, driver } as never);
    expect(refused).toMatchObject({ ok: false });
    expect(refused.content).toBe('nothing was written: bad: its model_id points at a ir.model record (id 9) that has no XML id to name it by');
    expect(await made().export_customizations!({ name: 'export_customizations', parsed: { refs: ['x'] }, caller: { ownerId: 'bo', treeId: 't1' }, driver: undefined } as never)).toMatchObject({ ok: false, content: 'this run has no workspace to write the module into' });
  });
});

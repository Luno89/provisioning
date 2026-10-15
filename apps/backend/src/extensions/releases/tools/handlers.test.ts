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

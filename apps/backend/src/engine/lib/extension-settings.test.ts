import { describe, it, expect } from 'vitest';
import { enabledExtensions, extensionOf, hiddenBy, switchedOffProblems, switchProblem, withSwitch } from './extension-settings.js';

const INSTALLED = [
  { id: 'platform', title: 'Platform', tools: [{ name: 'list_tasks' }], personas: [{ slug: 'koala' }] },
  { id: 'grove', title: 'Grove', requires: ['platform'], operations: [{ name: 'grove.open-tree' }], tools: [{ name: 'claim_leaf' }], personas: [{ slug: 'grove' }] },
  { id: 'notes', title: 'Notes', requires: ['grove'], groups: [{ id: 'notes.jot' }] },
];

describe('which extensions an owner has on', () => {
  it('is every installed one but those switched off, and never without the platform', () => {
    expect(enabledExtensions(INSTALLED, undefined).map((extension) => extension.id)).toEqual(['platform', 'grove', 'notes']);
    expect(enabledExtensions(INSTALLED, { disabled: ['notes', 'platform'] }).map((extension) => extension.id)).toEqual(['platform', 'grove']);
  });

  it('hides exactly what a switched-off extension brings', () => {
    const hidden = hiddenBy(INSTALLED, { disabled: ['grove', 'notes'] });
    expect([...hidden.extensions]).toEqual(['grove', 'notes']);
    expect([...hidden.operations]).toEqual(['grove.open-tree']);
    expect([...hidden.groups]).toEqual(['notes.jot']);
    expect([...hidden.tools]).toEqual(['claim_leaf']);
    expect([...hidden.agents]).toEqual(['grove']);
  });

  it('says which extension a node belongs to', () => {
    expect(extensionOf(INSTALLED, 'operation', 'grove.open-tree')?.id).toBe('grove');
    expect(extensionOf(INSTALLED, 'group', 'notes.jot')?.id).toBe('notes');
    expect(extensionOf(INSTALLED, 'operation', 'other.thing')).toBeUndefined();
  });
});

describe('switching an extension', () => {
  it('refuses to switch off the platform, or what something still on needs', () => {
    expect(switchProblem(INSTALLED, [], 'platform', false)).toMatch(/cannot be switched off/);
    expect(switchProblem(INSTALLED, [], 'grove', false)).toMatch(/Notes needs Grove/);
    expect(switchProblem(INSTALLED, ['notes'], 'grove', false)).toBeNull();
  });

  it('refuses to switch on what needs something that is off', () => {
    expect(switchProblem(INSTALLED, ['grove', 'notes'], 'notes', true)).toMatch(/needs grove, which is switched off/);
    expect(switchProblem(INSTALLED, ['notes'], 'notes', true)).toBeNull();
    expect(switchProblem(INSTALLED, [], 'ghost', true)).toMatch(/no extension called "ghost"/);
  });

  it('records the switch for the owner', () => {
    const off = withSwitch(undefined, 'u1', 'grove', false, 'now');
    expect(off).toEqual({ ownerId: 'u1', disabled: ['grove'], updatedAt: 'now' });
    expect(withSwitch(off, 'u1', 'grove', true, 'later')).toEqual({ ownerId: 'u1', disabled: [], updatedAt: 'later' });
  });
});

describe('a procedure using a switched-off extension', () => {
  it('is refused at each node that uses it — an operation, a group, or a hand-off to one of its agents', () => {
    const hidden = hiddenBy(INSTALLED, { disabled: ['grove', 'notes'] });
    const place = (id: string, kind: string, settings: Record<string, unknown> = {}, group?: string) => ({ id, kind, settings, ...(group ? { group } : {}) });

    const problems = switchedOffProblems({
      nodes: [place('open', 'host-op', { operation: 'grove.open-tree' }), place('jot', 'group', {}, 'notes.jot'), place('grow', 'delegate', { agent: 'grove' }), place('chat', 'delegate', { agent: 'koala' })],
      groups: [{ id: 'inner', nodes: [place('again', 'host-op', { operation: 'grove.open-tree' })] }],
    }, hidden);

    expect(problems.map((problem) => problem.node)).toEqual(['open', 'jot', 'grow', 'again']);
    expect(problems[0]!.message).toMatch(/grove extension, which is switched off for you/);
  });
});

import { describe, it, expect } from 'vitest';
import { usesNode } from './procedure-reach.js';

const node = (id: string, kind: string, group?: string) => ({ id, kind, settings: {}, position: { x: 0, y: 0 }, ...(group ? { group } : {}) });
const group = (id: string, nodes: ReturnType<typeof node>[]) => ({ id, title: id, describe: '', inputs: [], outputs: [], exits: [], nodes, wires: [], flow: [], groups: [] }) as never;

describe('whether a procedure runs a kind of node', () => {
  it('finds it at the top, inside its own groups and inside shared ones, and survives a group that names itself', () => {
    expect(usesNode({ nodes: [node('a', 'recall-memory')], groups: [] }, 'recall-memory')).toBe(true);
    expect(usesNode({ nodes: [node('g', 'group', 'context')], groups: [group('context', [node('r', 'recall-memory')])] }, 'recall-memory')).toBe(true);
    expect(usesNode({ nodes: [node('g', 'group', 'shared')], groups: [] }, 'recall-memory', [group('shared', [node('r', 'recall-memory')])])).toBe(true);
    expect(usesNode({ nodes: [node('g', 'group', 'loop')], groups: [group('loop', [node('again', 'group', 'loop')])] }, 'recall-memory')).toBe(false);
    expect(usesNode({ nodes: [node('a', 'call-model')], groups: [] }, 'recall-memory')).toBe(false);
  });
});

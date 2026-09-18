import { describe, it, expect } from 'vitest';
import { SINGLE_SHOT_V2 } from '../seeds/procedures.js';
import { placeUnplaced } from './place.js';

describe('placing nodes the code did not position', () => {
  it('keeps where a node already was, and puts new ones in rows below everything placed', () => {
    const moved = { ...SINGLE_SHOT_V2, nodes: SINGLE_SHOT_V2.nodes.map((node) => ({ ...node, position: node.id === 'call' ? { x: 0, y: 0 } : node.position })) };
    const withNew = { ...moved, nodes: [...moved.nodes, { id: 'extra', kind: 'text', settings: {}, position: { x: 0, y: 0 } }] };

    const placed = placeUnplaced(withNew, ['call', 'extra'], SINGLE_SHOT_V2);
    const bottom = Math.max(...SINGLE_SHOT_V2.nodes.filter((node) => node.id !== 'call').map((node) => node.position.y));

    expect(placed.nodes.find((node) => node.id === 'call')?.position).toEqual(SINGLE_SHOT_V2.nodes.find((node) => node.id === 'call')?.position);
    expect(placed.nodes.find((node) => node.id === 'extra')?.position).toEqual({ x: 0, y: bottom + 140 });
  });

  it('places nodes inside a group within that group', () => {
    const grouped = { ...SINGLE_SHOT_V2, groups: [{ id: 'g', title: 'G', describe: '', start: 'a', nodes: [{ id: 'a', kind: 'text', settings: {}, position: { x: 0, y: 0 } }, { id: 'b', kind: 'text', settings: {}, position: { x: 0, y: 0 } }], wires: [], flow: [], inputs: [], outputs: [], exits: [] }] };

    const placed = placeUnplaced(grouped, ['g/a', 'g/b']);

    expect(placed.groups[0]!.nodes.map((node) => node.position)).toEqual([{ x: 0, y: 0 }, { x: 260, y: 0 }]);
  });
});

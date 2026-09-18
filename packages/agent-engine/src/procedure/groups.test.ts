import { describe, it, expect } from 'vitest';
import { expandGroups, groupAsNode, groupLibrary, GroupExpansionError, MAX_GROUP_EXPANSIONS } from './groups.js';
import { flow, group, groupNode, node, procedure, wire } from '../../testing/procedure-nodes.js';

const turn = group({
  id: 'turn',
  start: 'ask',
  nodes: [node('prefix', 'note', { text: 'be brief' }), node('join', 'join-text'), node('ask', 'ask')],
  wires: [wire('prefix:text', 'join:parts'), wire('join:text', 'ask:prompt')],
  inputs: [{ name: 'question', type: 'text', describe: 'The question', required: true, to: [{ node: 'join', socket: 'parts' }] }],
  outputs: [{ name: 'answer', type: 'text', describe: 'The answer', from: { node: 'ask', socket: 'reply' } }],
  exits: [
    { name: 'agreed', describe: 'It said yes', from: { node: 'ask', exit: 'yes' } },
    { name: 'refused', describe: 'It said no', from: { node: 'ask', exit: 'no' } },
  ],
});

const outer = procedure({
  start: 'first',
  nodes: [
    node('question', 'note', { text: 'ready?' }),
    node('first', 'echo'),
    groupNode('t', 'turn'),
    node('show', 'echo'),
    node('done', 'finish', { outcome: 'ok' }),
  ],
  wires: [wire('question:text', 't:question'), wire('t:answer', 'show:text')],
  flow: [flow('first:done', 't'), flow('t:agreed', 'show'), flow('t:refused', 'done'), flow('show:done', 'done')],
  groups: [turn],
});

describe('expanding groups', () => {
  it('puts the group\'s nodes in place of the group node, named inside it', () => {
    const { body } = expandGroups(outer, groupLibrary(outer));

    expect(body.nodes.map((placed) => placed.id).sort()).toEqual(
      ['done', 'first', 'question', 'show', 't.ask', 't.join', 't.prefix'].sort(),
    );
  });

  it('keeps the wires inside the group, renamed', () => {
    const { body } = expandGroups(outer, groupLibrary(outer));

    expect(body.wires).toContainEqual(wire('t.prefix:text', 't.join:parts'));
    expect(body.wires).toContainEqual(wire('t.join:text', 't.ask:prompt'));
  });

  it('carries a wire into the group through to every socket the input feeds', () => {
    const { body } = expandGroups(outer, groupLibrary(outer));

    expect(body.wires).toContainEqual(wire('question:text', 't.join:parts'));
  });

  it('feeds one group input into every socket inside the group that it names', () => {
    const both = group({
      ...turn,
      nodes: [...turn.nodes, node('log', 'echo')],
      inputs: [{ ...turn.inputs[0]!, to: [{ node: 'join', socket: 'parts' }, { node: 'log', socket: 'text' }] }],
    });
    const subject = { ...outer, groups: [both] };

    const { body } = expandGroups(subject, groupLibrary(subject));

    expect(body.wires).toContainEqual(wire('question:text', 't.join:parts'));
    expect(body.wires).toContainEqual(wire('question:text', 't.log:text'));
  });

  it('takes a wire out of the group from the socket its output comes from', () => {
    const { body } = expandGroups(outer, groupLibrary(outer));

    expect(body.wires).toContainEqual(wire('t.ask:reply', 'show:text'));
  });

  it('enters the group at its start, and leaves through the exit each group exit names', () => {
    const { body } = expandGroups(outer, groupLibrary(outer));

    expect(body.flow).toEqual(expect.arrayContaining([
      flow('first:done', 't.ask'),
      flow('t.ask:yes', 'show'),
      flow('t.ask:no', 'done'),
    ]));
  });

  it('starts inside the group when the procedure starts on it', () => {
    const { body } = expandGroups({ ...outer, start: 't' }, groupLibrary(outer));

    expect(body.start).toBe('t.ask');
  });

  it('remembers which node on the canvas each expanded node came from', () => {
    const { origin } = expandGroups(outer, groupLibrary(outer));

    expect(origin.get('t.ask')).toBe('t');
    expect(origin.get('show')).toBe('show');
    expect(origin.has('t')).toBe(false);
  });

  it('expands a group inside a group, and still traces it to the outermost node', () => {
    const wrapper = group({
      id: 'wrapper',
      start: 'inner',
      nodes: [groupNode('inner', 'turn')],
      inputs: [{ name: 'question', type: 'text', describe: 'Q', to: [{ node: 'inner', socket: 'question' }] }],
      outputs: [{ name: 'answer', type: 'text', describe: 'A', from: { node: 'inner', socket: 'answer' } }],
      exits: [
        { name: 'agreed', describe: 'yes', from: { node: 'inner', exit: 'agreed' } },
        { name: 'refused', describe: 'no', from: { node: 'inner', exit: 'refused' } },
      ],
    });
    const nested = { ...outer, nodes: outer.nodes.map((placed) => (placed.id === 't' ? groupNode('t', 'wrapper') : placed)), groups: [turn, wrapper] };

    const { body, origin } = expandGroups(nested, groupLibrary(nested));

    expect(body.nodes.map((placed) => placed.id)).toContain('t.inner.ask');
    expect(body.flow).toContainEqual(flow('t.inner.ask:yes', 'show'));
    expect(body.wires).toContainEqual(wire('question:text', 't.inner.join:parts'));
    expect(origin.get('t.inner.ask')).toBe('t');
  });

  it('refuses a group that contains itself, naming the chain', () => {
    const loop = group({ id: 'loop', start: 'again', nodes: [groupNode('again', 'loop')] });
    const looping = procedure({ start: 'g', nodes: [groupNode('g', 'loop')], groups: [loop] });

    expect(() => expandGroups(looping, groupLibrary(looping))).toThrow(GroupExpansionError);
    expect(() => expandGroups(looping, groupLibrary(looping))).toThrow('group "loop" contains itself (loop → loop)');
  });

  it('stops when nested groups multiply past the limit instead of running away', () => {
    const levels = 8;
    const groups = Array.from({ length: levels }, (_, level) => group({
      id: `level${level}`,
      start: 'a',
      nodes: level === levels - 1
        ? [node('a', 'finish', { outcome: 'ok' })]
        : ['a', 'b', 'c'].map((id) => groupNode(id, `level${level + 1}`)),
    }));
    const subject = procedure({ start: 'top', nodes: [groupNode('top', 'level0')], groups });

    expect(3 ** (levels - 1)).toBeGreaterThan(MAX_GROUP_EXPANSIONS);
    expect(() => expandGroups(subject, groupLibrary(subject))).toThrow(
      `expanding groups produced more than ${MAX_GROUP_EXPANSIONS} group nodes, so it was stopped`,
    );
  });

  it('refuses a group that does not exist, naming the node that uses it', () => {
    const missing = procedure({ start: 'g', nodes: [groupNode('g', 'nowhere')] });

    try {
      expandGroups(missing, groupLibrary(missing));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GroupExpansionError);
      expect((err as GroupExpansionError).node).toBe('g');
    }
  });

  it('prefers a group defined in the procedure over a shared one with the same id', () => {
    const shared = { ...turn, title: 'Shared turn' };

    expect(groupLibrary(outer, [shared]).get('turn')?.title).toBe('turn');
    expect(groupLibrary({ groups: [] }, [shared]).get('turn')?.title).toBe('Shared turn');
  });

  it('presents a group on the canvas as one step with the sockets and exits it exposes', () => {
    const asNode = groupAsNode(turn);

    expect(asNode.role).toBe('step');
    expect(asNode.inputs).toEqual([{ name: 'question', type: 'text', describe: 'The question', required: true }]);
    expect(asNode.outputs.map((socket) => socket.name)).toEqual(['answer']);
    expect(asNode.exits.map((exit) => exit.name)).toEqual(['agreed', 'refused']);
  });
});

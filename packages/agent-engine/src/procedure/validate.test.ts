import { describe, it, expect } from 'vitest';
import { checkProcedure, procedureErrors, type ProcedureProblem } from './validate.js';
import type { Procedure } from './schema.js';
import { flow, group, groupNode, node, procedure, testCatalogue, wire } from '../../testing/procedure-nodes.js';

const catalogue = testCatalogue();
const check = (subject: Procedure, known = {}) => checkProcedure(subject, { catalogue, known });
const messages = (problems: readonly ProcedureProblem[]) => problems.map((problem) => problem.message);

const clean = procedure({
  start: 'ask',
  nodes: [
    node('greeting', 'note', { text: 'hello' }),
    node('ask', 'ask'),
    node('agreed', 'finish', { outcome: 'ok' }),
    node('refused', 'finish', { outcome: 'failed', reason: 'said no' }),
  ],
  wires: [wire('greeting:text', 'ask:prompt')],
  flow: [flow('ask:yes', 'agreed'), flow('ask:no', 'refused')],
});

const replacing = (base: Procedure, over: Partial<Procedure>): Procedure => ({ ...base, ...over });

describe('checking a procedure', () => {
  it('finds nothing wrong with a procedure that is wired and routed completely', () => {
    expect(check(clean)).toEqual([]);
  });

  it('only checks the current format', () => {
    expect(messages(check({ ...clean, schema: 1 as never }))).toEqual([
      'this procedure is in format 1, and only format 2 can be checked',
    ]);
  });

  describe('nodes', () => {
    it('names a node whose kind does not exist', () => {
      const problems = check(replacing(clean, { nodes: [...clean.nodes, node('mystery', 'teleport')] }));

      expect(problems).toContainEqual({ severity: 'error', node: 'mystery', message: 'is a "teleport" node, which is not a kind of node' });
    });

    it('puts a settings problem on the node that has it', () => {
      const problems = check(replacing(clean, {
        nodes: clean.nodes.map((placed) => (placed.id === 'agreed' ? node('agreed', 'finish', { outcome: 'great' }) : placed)),
      }));

      expect(problems).toContainEqual({ severity: 'error', node: 'agreed', message: 'settings.outcome has to be one of "ok", "failed", not "great"' });
    });

    it('asks a node to check its own references against what exists', () => {
      const withTool = procedure({
        start: 'call',
        nodes: [node('call', 'call-tool', { tool: 'launch_rockets' }), node('end', 'finish', { outcome: 'ok' })],
        flow: [flow('call:done', 'end')],
      });

      expect(check(withTool, { tools: new Set(['read_file']) })).toContainEqual({
        severity: 'error', node: 'call', message: 'calls "launch_rockets", which is not a tool',
      });
      expect(check(withTool)).toEqual([]);
    });

    it('refuses two nodes with the same id, and a dot in an id', () => {
      const problems = messages(check(replacing(clean, { nodes: [...clean.nodes, node('ask', 'echo'), node('a.b', 'echo')] })));

      expect(problems).toContain('two nodes share the id "ask"');
      expect(problems).toContain('has "." in its id, which is reserved for nodes inside groups');
    });
  });

  describe('wires', () => {
    it('refuses a wire between sockets that carry different things', () => {
      const problems = check(procedure({
        start: 'count',
        budget: { maxRounds: 5 },
        nodes: [node('count', 'count', { limit: 2 }), node('ask', 'ask'), node('end', 'finish', { outcome: 'ok' })],
        wires: [wire('count:count', 'ask:prompt')],
        flow: [flow('count:again', 'count'), flow('count:done', 'ask'), flow('ask:yes', 'end'), flow('ask:no', 'end')],
      }));

      expect(problems).toContainEqual({ severity: 'error', node: 'ask', socket: 'prompt', message: 'takes text, but "count.count" produces json' });
    });

    it('names a socket that does not exist on either end', () => {
      const problems = check(replacing(clean, { wires: [wire('greeting:words', 'ask:prompt'), wire('greeting:text', 'ask:question')] }));

      expect(problems).toContainEqual({ severity: 'error', node: 'greeting', socket: 'words', message: 'is wired from "words", which "greeting" does not produce' });
      expect(problems).toContainEqual({ severity: 'error', node: 'ask', socket: 'question', message: 'is wired into "question", which this node does not take' });
    });

    it('refuses two wires into a socket that takes one', () => {
      const problems = check(replacing(clean, {
        nodes: [...clean.nodes, node('other', 'note', { text: 'hi' })],
        wires: [...clean.wires, wire('other:text', 'ask:prompt')],
      }));

      expect(problems).toContainEqual({ severity: 'error', node: 'ask', socket: 'prompt', message: 'has 2 wires into "prompt", which takes only one' });
    });

    it('accepts several wires into a socket that takes many', () => {
      const problems = check(replacing(clean, {
        nodes: [...clean.nodes, node('other', 'note', { text: 'hi' }), node('joined', 'join-text')],
        wires: [wire('greeting:text', 'joined:parts'), wire('other:text', 'joined:parts'), wire('joined:text', 'ask:prompt')],
      }));

      expect(problems).toEqual([]);
    });

    it('says which required input has nothing wired into it', () => {
      expect(check(replacing(clean, { wires: [] }))).toContainEqual({
        severity: 'error', node: 'ask', socket: 'prompt', message: 'needs "prompt", and nothing is wired into it',
      });
    });

    it('refuses value nodes that feed each other in a circle', () => {
      const problems = messages(check(replacing(clean, {
        nodes: [...clean.nodes, node('a', 'join-text'), node('b', 'join-text')],
        wires: [wire('a:text', 'b:parts'), wire('b:text', 'a:parts'), wire('a:text', 'ask:prompt')],
      })));

      expect(problems.filter((message) => message.includes('in a circle'))).toHaveLength(1);
    });

    it('warns about a value node nothing reads', () => {
      expect(check(replacing(clean, { nodes: [...clean.nodes, node('spare', 'note', { text: 'unused' })] }))).toEqual([
        { severity: 'warning', node: 'spare', message: 'nothing reads what this produces' },
      ]);
    });
  });

  describe('flow', () => {
    it('says which exit leads nowhere', () => {
      expect(check(replacing(clean, { flow: [flow('ask:yes', 'agreed')] }))).toContainEqual({
        severity: 'error', node: 'ask', exit: 'no', message: 'can leave through "no", but nothing says where that goes',
      });
    });

    it('refuses an exit a node does not have, and an exit that goes two places', () => {
      const problems = check(replacing(clean, {
        flow: [...clean.flow, flow('ask:maybe', 'agreed'), flow('ask:yes', 'refused')],
      }));

      expect(problems).toContainEqual({ severity: 'error', node: 'ask', exit: 'maybe', message: 'has no exit called "maybe"' });
      expect(problems).toContainEqual({ severity: 'error', node: 'ask', exit: 'yes', message: 'leaves through "yes" to more than one place' });
    });

    it('refuses flow into or out of a value node', () => {
      const problems = messages(check(replacing(clean, {
        flow: [...clean.flow.filter((entry) => entry.exit !== 'no'), flow('ask:no', 'greeting'), flow('greeting:text', 'agreed')],
      })));

      expect(problems).toContain('leads to "greeting", which is a value node and never runs on its own');
      expect(problems).toContain('is a value node, so it cannot lead anywhere — only steps run in order');
    });

    it('refuses to start on a value node or a node that does not exist', () => {
      expect(messages(check(replacing(clean, { start: 'greeting' })))).toContain(
        'the start node has to be a step, and "greeting" is a value node',
      );
      expect(messages(check(replacing(clean, { start: 'nowhere' })))).toContain('the start node "nowhere" does not exist');
    });

    it('warns about a step nothing leads to', () => {
      expect(check(replacing(clean, { nodes: [...clean.nodes, node('orphan', 'finish', { outcome: 'ok' })] }))).toEqual([
        { severity: 'warning', node: 'orphan', message: 'nothing leads to this step, so it never runs' },
      ]);
    });

    it('refuses a step that can never reach a finish', () => {
      const problems = check(procedure({
        start: 'spin',
        budget: { maxRounds: 3 },
        nodes: [node('spin', 'echo'), node('end', 'finish', { outcome: 'ok' })],
        flow: [flow('spin:done', 'spin')],
      }));

      expect(problems).toContainEqual({ severity: 'error', node: 'spin', message: 'no path from here ever finishes' });
    });

    it('lets a loop run with no budget, since limits are learned from how long runs take', () => {
      const looping = procedure({
        start: 'count',
        budget: {},
        nodes: [node('count', 'count', { limit: 3 }), node('end', 'finish', { outcome: 'ok' })],
        wires: [wire('count:count', 'count:previous')],
        flow: [flow('count:again', 'count'), flow('count:done', 'end')],
      });

      expect(check(looping)).toEqual([]);
    });

    it('warns when the model can be called round and round with nothing watching for circles', () => {
      const circling = procedure({
        start: 'ask',
        budget: {},
        nodes: [node('prompt', 'note', { text: 'again?' }), node('ask', 'ask'), node('agreed', 'finish', { outcome: 'ok' })],
        wires: [wire('prompt:text', 'ask:prompt')],
        flow: [flow('ask:no', 'ask'), flow('ask:yes', 'agreed')],
      });
      const watched = {
        ...circling,
        nodes: [...circling.nodes, node('watch', 'watch'), node('stuck', 'finish', { outcome: 'failed' })],
        flow: [flow('ask:no', 'watch'), flow('watch:ok', 'ask'), flow('watch:tripped', 'stuck'), flow('ask:yes', 'agreed')],
      };

      expect(check(circling)).toEqual([{
        severity: 'warning',
        message: 'this procedure can call the model again and again, and nothing in it watches for going in circles — add a Check Repetition or Check Stall node to the loop',
      }]);
      expect(check(watched)).toEqual([]);
      expect(check({ ...circling, budget: { maxRounds: 5 } })).toEqual([]);
    });

    it('checks the cleanup node like the start node', () => {
      expect(messages(check({ ...clean, cleanup: 'greeting' }))).toContain(
        'the cleanup node has to be a step, and "greeting" is a value node',
      );
    });
  });

  describe('groups', () => {
    const turn = group({
      id: 'turn',
      start: 'ask',
      nodes: [node('ask', 'ask')],
      inputs: [{ name: 'question', type: 'text', describe: 'Q', required: true, to: [{ node: 'ask', socket: 'prompt' }] }],
      outputs: [{ name: 'answer', type: 'text', describe: 'A', from: { node: 'ask', socket: 'reply' } }],
      exits: [
        { name: 'agreed', describe: 'yes', from: { node: 'ask', exit: 'yes' } },
        { name: 'refused', describe: 'no', from: { node: 'ask', exit: 'no' } },
      ],
    });

    const usingTurn = procedure({
      start: 't',
      nodes: [node('q', 'note', { text: 'ready?' }), groupNode('t', 'turn'), node('end', 'finish', { outcome: 'ok' })],
      wires: [wire('q:text', 't:question')],
      flow: [flow('t:agreed', 'end'), flow('t:refused', 'end')],
      groups: [turn],
    });

    it('treats a group node as a step with the group\'s sockets and exits', () => {
      expect(check(usingTurn)).toEqual([]);
      expect(check({ ...usingTurn, flow: [flow('t:agreed', 'end')] })).toContainEqual({
        severity: 'error', node: 't', exit: 'refused', message: 'can leave through "refused", but nothing says where that goes',
      });
    });

    it('counts a group input as a wire into the socket it feeds, and a group exit as a way out', () => {
      expect(check(usingTurn).filter((problem) => problem.group === 'turn')).toEqual([]);
    });

    it('tags a problem inside a group with the group it is in', () => {
      const broken = { ...turn, inputs: [{ ...turn.inputs[0]!, type: 'json' as const }] };

      expect(check({ ...usingTurn, groups: [broken] })).toContainEqual({
        severity: 'error',
        group: 'turn',
        node: 'ask',
        socket: 'prompt',
        message: 'the group\'s input "question" carries json, but this socket takes text',
      });
    });

    it('refuses an exit that both leaves the group and leads somewhere inside it', () => {
      const confused = { ...turn, nodes: [...turn.nodes, node('inner', 'finish', { outcome: 'ok' })], flow: [flow('ask:yes', 'inner')] };

      expect(messages(check({ ...usingTurn, groups: [confused] }))).toContain(
        '"yes" already leaves the group, so it cannot also lead somewhere inside it',
      );
    });

    it('names a group node whose group does not exist', () => {
      expect(check({ ...usingTurn, groups: [] })).toContainEqual({
        severity: 'error', node: 't', message: 'uses group "turn", which does not exist',
      });
    });

    it('refuses a group that contains itself', () => {
      const selfish = group({
        id: 'selfish',
        start: 'me',
        nodes: [groupNode('me', 'selfish')],
        exits: [{ name: 'out', describe: 'out', from: { node: 'me', exit: 'out' } }],
      });
      const subject = procedure({
        start: 's',
        nodes: [groupNode('s', 'selfish'), node('end', 'finish', { outcome: 'ok' })],
        flow: [flow('s:out', 'end')],
        groups: [selfish],
      });

      expect(procedureErrors(check(subject)).map((problem) => problem.message)).toContain(
        'group "selfish" contains itself (selfish → selfish)',
      );
    });

    it('checks shared groups the procedure uses without re-reporting their insides', () => {
      const subject = { ...usingTurn, groups: [] };

      expect(checkProcedure(subject, { catalogue, groups: [turn] })).toEqual([]);
    });
  });
});

import { describe, it, expect } from 'vitest';
import {
  BUILT_IN_PROCEDURES,
  type Procedure,
} from '@koala/agent-engine/procedure';
import { composedRequests, said, type ComposeOptions } from './composed-request.js';

const procedure = (id: string): Procedure => {
  const found = BUILT_IN_PROCEDURES.find((entry) => entry.id === id);
  if (!found) throw new Error(`there is no built-in procedure called "${id}"`);
  return found;
};

const TASK = {
  id: 'write-greeting',
  title: 'Write hello.txt',
  doneMeans: 'A file called hello.txt exists in the workspace and contains exactly the word hello, with no trailing newline.',
};

interface Carries {
  agent: string;
  run: Omit<ComposeOptions, 'procedure' | 'agent'>;
  mustSay: string[];
  mustOffer?: string[];
  mustNotOffer?: string[];
}

const MUST_CARRY: Record<string, Carries> = {
  'do-one-task': {
    agent: 'executor',
    run: { message: 'Do the task you have been given.', inputs: { item: TASK } },
    mustSay: [TASK.id, TASK.title, 'contains exactly the word hello', 'The task has already been claimed for you.'],
    mustOffer: ['run_command', 'write_file'],
    mustNotOffer: ['start_task', 'mark_done', 'mark_failed', 'judge'],
  },
  planning: {
    agent: 'planner',
    run: { message: 'Add a GET /healthz endpoint that returns {"ok":true}.' },
    mustSay: ['/healthz'],
    mustOffer: ['propose_work', 'list_tasks'],
  },
  research: {
    agent: 'research',
    run: { message: 'Which company originally developed the Rust programming language?' },
    mustSay: ['Rust programming language'],
    mustOffer: ['search_web', 'fetch_web_page'],
  },
  'tool-rounds': {
    agent: 'agent-builder',
    run: { message: 'Show me how the research procedure is set up.' },
    mustSay: ['research procedure'],
    mustOffer: ['read_procedure', 'save_procedure'],
  },
  'interactive-chat': {
    agent: 'koala',
    run: { message: 'What does this platform actually do?' },
    mustSay: ['What does this platform actually do?'],
  },
  'single-shot': {
    agent: 'judge',
    run: { message: 'Does this work meet what was asked?' },
    mustSay: ['Does this work meet what was asked?'],
  },
  delivery: {
    agent: 'delivery',
    run: {
      message: 'Create a file called hello.txt containing exactly the word hello.',
      inputs: { goal: 'Create a file called hello.txt containing exactly the word hello.' },
    },
    mustSay: ['hello.txt'],
  },
  'run-leaf': {
    agent: 'leaf-executor',
    run: {
      message: 'Work the leaf you have been given.',
      inputs: {
        leafId: 'leaf-r1',
        leafTitle: 'The server answers /health',
        leafBody: 'The server answers /health on :3000',
        siblings: '3 other leaves are working in this tree at the same time, among them "The logger writes to the file"',
      },
    },
    mustSay: ['leaf-r1', 'The server answers /health on :3000', '3 other leaves are working in this tree at the same time'],
    mustOffer: ['claim_leaf', 'list_tasks', 'run_command', 'executor'],
    mustNotOffer: ['settle_leaf'],
  },
};

describe('what each built-in procedure actually puts in front of the model', () => {
  for (const [id, carries] of Object.entries(MUST_CARRY)) {
    it(`${id} tells the model everything the run was given`, async () => {
      const { requests } = await composedRequests({ procedure: procedure(id), agent: carries.agent, ...carries.run });

      expect(requests.length, 'the model was never called').toBeGreaterThan(0);
      const first = requests[0]!;

      for (const text of carries.mustSay) {
        expect(`${first.system}\n${said(first)}`, `${id} never told the model about "${text}"`).toContain(text);
      }
      for (const tool of carries.mustOffer ?? []) {
        expect(first.toolNames, `${id} did not offer ${tool}`).toContain(tool);
      }
      for (const tool of carries.mustNotOffer ?? []) {
        expect(first.toolNames, `${id} offered ${tool}, which the procedure does itself`).not.toContain(tool);
      }
    });
  }

  it('every built-in procedure says what its context has to carry', () => {
    expect(BUILT_IN_PROCEDURES.map((entry) => entry.id).sort()).toEqual(Object.keys(MUST_CARRY).sort());
  });
});

describe('what the model is sent on the turns after the first', () => {
  it('carries each tool result back by the id the model asked with', async () => {
    const { requests } = await composedRequests({
      procedure: procedure('tool-rounds'),
      agent: 'agent-builder',
      message: 'Show me the research procedure.',
      replies: [
        { toolCalls: [{ id: 'call-7', name: 'read_procedure', arguments: '{"procedure":"research"}' }] },
        { content: 'It answers once and stops.' },
      ],
      tools: async () => ({ ok: true, digest: 'the research procedure asks once', content: 'the research procedure asks once' }),
    });

    expect(requests).toHaveLength(2);
    const second = requests[1]!;
    const answer = second.messages.find((message) => message.tool_call_id === 'call-7');

    expect(answer, 'the tool result never came back to the model').toBeDefined();
    expect(answer!.content).toContain('the research procedure asks once');
    expect(second.system).toBe(requests[0]!.system);
  });

  it('keeps the first ask in view on a later turn', async () => {
    const { requests } = await composedRequests({
      procedure: procedure('tool-rounds'),
      agent: 'agent-builder',
      message: 'Show me the research procedure.',
      replies: [
        { toolCalls: [{ id: 'call-1', name: 'read_procedure', arguments: '{"procedure":"research"}' }] },
        { content: 'Here it is.' },
      ],
    });

    expect(said(requests[1]!)).toContain('Show me the research procedure.');
  });
});

describe('a run that was not given what its procedure reads', () => {
  it('stops and names the value, rather than quietly sending an empty one', async () => {
    const { result } = await composedRequests({
      procedure: procedure('delivery'),
      agent: 'delivery',
      message: 'Create a file called hello.txt.',
    });

    expect(result.outcome).toBe('failed');
    expect(result.reason).toContain('values.goal');
    expect(result.reason).toContain('was not given');
  });
});

describe('a reply the token cap cut off', () => {
  it('fails, saying so, when the model never got as far as saying anything', async () => {
    const { result } = await composedRequests({
      procedure: procedure('tool-rounds'),
      agent: 'agent-builder',
      message: 'Show me the research procedure.',
      replies: [{ thinking: 'weighing it up and up and up', finishReason: 'length' }],
    });

    expect(result.outcome).toBe('failed');
    expect(result.reason).toBe('the reply hit the token cap before it said anything');
  });

  it('keeps what it did manage to say', async () => {
    const { result } = await composedRequests({
      procedure: procedure('tool-rounds'),
      agent: 'agent-builder',
      message: 'Show me the research procedure.',
      replies: [{ content: 'It asks once and sto', finishReason: 'length' }],
    });

    expect(result.outcome).toBe('ok');
    expect(result.finishedBy).toBe('truncated');
  });
});

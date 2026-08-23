/**
 * The planning cycle, driven by a fake model.
 *
 * No inference here on purpose: what needs proving is that the turn assembles the same prompt as
 * chat, offers the same tools, and executes them through the same runner — because a runner that
 * reimplements any of that measures the reimplementation. Whether the model decomposes WELL is a
 * question for an experiment against a real endpoint, which is what this makes possible.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryDB } from './memory-db.js';
import { runPlanningTurn, MAX_PLANNING_ROUNDS, PLANNER_TOOLS } from './planning-turn.js';
import type { LeafToolContext } from './leaf-tool-runner.js';
import { PLAN_SYSTEM_PROMPT } from './plan-mode.js';

let db: MemoryDB;

const tools = (over: Partial<LeafToolContext> = {}): LeafToolContext => ({
  db, userId: 'u1', branchId: 'b1',
  webSearch: async () => ({ hits: [], unavailable: false, answeredBy: 'searxng' as const }), fetchWebPage: async () => '',
  projects: {} as LeafToolContext['projects'],
  ...over,
});

/**
 * The fake model speaks SSE, because the runner streams.
 *
 * Not a stylistic choice: measured against the live endpoint, this model returns zero tool calls
 * when `stream` is false — in every prompt and sampler combination tried, including
 * `tool_choice: required`. A fake that answered in one JSON blob would pass tests the real
 * endpoint fails, which is the only kind of test worth nothing.
 */
const sse = (turn: { content?: string; calls?: { name: string; args: unknown }[] }): string => {
  const frames: string[] = [];
  if (turn.content) {
    frames.push(JSON.stringify({ choices: [{ delta: { content: turn.content } }] }));
  }
  (turn.calls ?? []).forEach((c, index) => {
    frames.push(JSON.stringify({
      choices: [{ delta: { tool_calls: [{
        index, id: `c${index}`, type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.args) },
      }] } }],
    }));
  });
  frames.push(JSON.stringify({ choices: [{ delta: {} }], usage: { total_tokens: 100 } }));
  return `${frames.map((f) => `data: ${f}`).join('\n\n')}\n\ndata: [DONE]\n\n`;
};

/** A model that plays a fixed script of turns, so the loop is exercised without inference. */
const scripted = (turns: { content?: string; calls?: { name: string; args: unknown }[] }[]) => {
  let i = 0;
  const seen: any[] = [];
  const impl = (async (_url: string, init: any) => {
    seen.push(JSON.parse(init.body));
    const turn = turns[Math.min(i++, turns.length - 1)] ?? {};
    return { ok: true, text: async () => sse(turn) };
  }) as unknown as typeof fetch;
  return { impl, seen };
};

const run = (turns: Parameters<typeof scripted>[0], over: any = {}) => {
  const model = scripted(turns);
  return runPlanningTurn({
    baseUrl: 'http://model', prompt: 'Build a GitHub API client',
    tools: tools(), fetchImpl: model.impl, ...over,
  }).then((result) => ({ result, sent: model.seen }));
};

beforeEach(async () => { db = new MemoryDB(); await db.init(); });

describe('what the model is asked', () => {
  it('sends exactly one system message, first — the invariant chat templates enforce', async () => {
    // More than one is rejected outright by the template, and the failure is total.
    const { sent } = await run([{ content: 'done' }]);
    const messages = sent[0].messages;

    expect(messages.filter((m: any) => m.role === 'system')).toHaveLength(1);
    expect(messages[0].role).toBe('system');
  });

  it('asks for a plan explicitly rather than letting a heuristic decide', async () => {
    // Chat picks between plan and ambient from a mode and a complexity tier. An experiment that
    // let that choice happen would be measuring the heuristic, not the decomposition.
    const { sent } = await run([{ content: 'done' }]);
    expect(sent[0].messages[0].content).toContain(PLAN_SYSTEM_PROMPT);
  });

  it('offers the leaf tools, including the ones that assign work', async () => {
    const { sent } = await run([{ content: 'done' }]);
    const names = sent[0].tools.map((t: any) => t.function.name);

    expect(names).toContain('propose_leaf');
    expect(names).toContain('list_personas');
  });

  it('composes a persona prompt into the same single system message', async () => {
    const { sent } = await run([{ content: 'done' }], {
      persona: { id: 'p1', ownerId: 'u1', name: 'Planner', overrides: {}, systemPrompt: 'YOU DECOMPOSE.',
        createdAt: 'x', updatedAt: 'x' },
    });

    expect(sent[0].messages.filter((m: any) => m.role === 'system')).toHaveLength(1);
    expect(sent[0].messages[0].content).toContain('YOU DECOMPOSE.');
  });

  it('nests a template_vars knob rather than sending it flat', async () => {
    // `think` travels as template_vars.enable_thinking. The hand-rolled override filter this used
    // to have sent it as a top-level `think`, which the engine accepts, ignores, and runs with
    // reasoning in whatever state it defaulted to.
    const { sent } = await run([{ content: 'done' }], {
      persona: { id: 'p1', ownerId: 'u1', name: 'P', overrides: { think: true },
        createdAt: 'x', updatedAt: 'x' },
    });

    expect(sent[0].think).toBeUndefined();
    expect(sent[0].template_vars).toMatchObject({ enable_thinking: true });
  });

  it('lets the resolved chain beat the built-in sampling', async () => {
    // The ordering bug, in the planning path: built-in defaults spread last silently undid the
    // profile for every key they set.
    const { sent } = await run([{ content: 'done' }], {
      persona: { id: 'p1', ownerId: 'u1', name: 'P', overrides: { frequency_penalty: 0 },
        createdAt: 'x', updatedAt: 'x' },
    });

    expect(sent[0].frequency_penalty).toBe(0);
  });

  it('applies the persona’s samplers but never sends a knob the loop only reads', async () => {
    const { sent } = await run([{ content: 'done' }], {
      persona: { id: 'p1', ownerId: 'u1', name: 'P', overrides: { temperature: 0.2, maxSteps: 30 },
        createdAt: 'x', updatedAt: 'x' },
    });

    expect(sent[0].temperature).toBe(0.2);
    // maxSteps is read by the agent loop and meaningless to the model — sending it is noise at
    // best and a rejected request at worst.
    expect(sent[0].maxSteps).toBeUndefined();
  });
});

describe('what the turn produces', () => {
  it('executes proposals through the shared runner, so leaves really exist', async () => {
    const { result } = await run([
      { calls: [
        { name: 'propose_leaf', args: { title: 'Build the client' } },
        { name: 'propose_leaf', args: { title: 'Test it', dependsOn: ['Build the client'] } },
      ] },
      { content: 'I proposed two leaves.' },
    ]);

    expect(result.leaves.map((l) => l.title)).toEqual(['Build the client', 'Test it']);
    // Ordering resolved by the same code the chat route runs.
    const first = result.leaves.find((l) => l.title === 'Build the client')!;
    expect(result.leaves.find((l) => l.title === 'Test it')!.dependsOn).toEqual([first.id]);
  });

  it('assigns a persona the model named', async () => {
    await db.savePersona({ id: 'p-coder', ownerId: 'u1', name: 'Coder', overrides: {},
      createdAt: 'x', updatedAt: 'x' } as any);
    const { result } = await run([
      { calls: [{ name: 'propose_leaf', args: { title: 'Write it', persona: 'Coder' } }] },
      { content: 'assigned' },
    ]);

    expect(result.leaves[0]!.personaId).toBe('p-coder');
  });

  it('keeps every tool call, so HOW it decomposed is readable, not just what it left', async () => {
    const { result } = await run([
      { calls: [{ name: 'list_personas', args: {} }] },
      { calls: [{ name: 'propose_leaf', args: { title: 'A' } }] },
      { content: 'done' },
    ]);

    expect(result.toolCalls.map((c) => c.name)).toEqual(['list_personas', 'propose_leaf']);
    expect(result.rounds).toBe(2);
  });

  it('stops calling tools eventually, and says it was the ceiling that stopped it', async () => {
    // A model that keeps proposing without answering is a loop, not a thorough planner — and the
    // run has to say which, because a capped plan may simply be unfinished.
    const { result } = await run([{ calls: [{ name: 'propose_leaf', args: { title: 'again' } }] }]);
    expect(result.rounds).toBe(MAX_PLANNING_ROUNDS);
    expect(result.exit).toBe('capped');
  });

  it('keeps prose from every round rather than letting the last one erase it', async () => {
    const { result } = await run([
      { content: 'First, the plan.', calls: [{ name: 'propose_leaf', args: { title: 'A' } }] },
      { content: 'Now the summary.' },
    ]);

    expect(result.reply).toContain('First, the plan.');
    expect(result.reply).toContain('Now the summary.');
  });

  it('records what it asked, so a score has its input beside it', async () => {
    const { result } = await run([{ content: 'done' }]);
    expect(result.request.systemPrompt).toContain(PLAN_SYSTEM_PROMPT);
    expect(result.request.tools).toContain('propose_leaf');
  });
});

describe('failure', () => {
  it('surfaces the engine’s own message when the call fails', async () => {
    const failing = (async () => ({ ok: false, status: 400, text: async () => 'bad sampler value' })) as unknown as typeof fetch;
    await expect(runPlanningTurn({
      baseUrl: 'http://model', prompt: 'x', tools: tools(), fetchImpl: failing,
    })).rejects.toThrow(/400.*bad sampler value/);
  });
});

describe('research, because the planner has no web access', () => {
  const findings = (answer: string) => ({ ok: true, text: async () => sse({ content: answer }) });

  it('does not offer live search, so the model is never misled by an empty result', () => {
    // The first version stubbed search to return nothing while still offering it. The model called
    // it, got nothing, and concluded there was no information — an artifact of the stub.
    const names = PLANNER_TOOLS.map((t) => t.function.name);
    expect(names).not.toContain('web_search');
    expect(names).not.toContain('fetch_web_page');
    expect(names).toContain('research');
  });

  it('tells the model plainly when research is unavailable', async () => {
    // Rather than returning empty findings, which reads as "there is nothing to know".
    const { result } = await run([
      { calls: [{ name: 'research', args: { questions: ['what is the rate limit?'] } }] },
      { content: 'planned anyway' },
    ]);

    expect(result.toolCalls[0]!.result).toMatch(/unavailable/i);
    expect(result.research).toHaveLength(0);
  });

  it('answers questions through a sub-agent and feeds the findings back', async () => {
    let call = 0;
    const impl = (async () => {
      call += 1;
      // 1: planner asks. 2: the research sub-agent answers. 3: planner proposes.
      if (call === 1) {
        return { ok: true, text: async () => sse({ calls: [{ name: 'research', args: { questions: ['what is the GitHub rate limit?'] } }] }) };
      }
      if (call === 2) return findings('5000 requests per hour for authenticated calls.');
      return { ok: true, text: async () => sse({ content: 'done' }) };
    }) as unknown as typeof fetch;

    const result = await runPlanningTurn({
      baseUrl: 'http://model', prompt: 'Plan a GitHub client', tools: tools(), fetchImpl: impl,
      research: { webSearch: async () => ({ hits: [], unavailable: false, answeredBy: 'searxng' as const }), fetchWebPage: async () => '' },
    });

    expect(result.research).toHaveLength(1);
    expect(result.research[0]!.findings).toMatch(/5000 requests/);
    expect(result.toolCalls[0]!.result).toMatch(/5000 requests/);
    expect(result.exit).toBe('satisfied');
  });

  it('stops when the planner asks something it already asked', async () => {
    // Asking twice means it failed to use the answer it was given, which is indistinguishable
    // from thoroughness without this check.
    const ask = { ok: true, text: async () => sse({ calls: [{ name: 'research', args: { questions: ['What is the rate limit?'] } }] }) };
    let call = 0;
    const impl = (async () => {
      call += 1;
      if (call === 2) return findings('5000/hour');
      return ask;
    }) as unknown as typeof fetch;

    const result = await runPlanningTurn({
      baseUrl: 'http://model', prompt: 'x', tools: tools(), fetchImpl: impl,
      research: { webSearch: async () => ({ hits: [], unavailable: false, answeredBy: 'searxng' as const }), fetchWebPage: async () => '' },
    });

    expect(result.exit).toBe('repeating');
    // The repeat is answered from what was already learned rather than researched again.
    expect(result.research).toHaveLength(1);
  });

  it('normalises questions, so punctuation is not a new question', async () => {
    const asks = (q: string) => ({ ok: true, text: async () => sse({ calls: [{ name: 'research', args: { questions: [q] } }] }) });
    let call = 0;
    const impl = (async () => {
      call += 1;
      if (call === 1) return asks('What is the rate limit?');
      if (call === 2) return findings('5000/hour');
      return asks('what is the rate limit');
    }) as unknown as typeof fetch;

    const result = await runPlanningTurn({
      baseUrl: 'http://model', prompt: 'x', tools: tools(), fetchImpl: impl,
      research: { webSearch: async () => ({ hits: [], unavailable: false, answeredBy: 'searxng' as const }), fetchWebPage: async () => '' },
    });

    expect(result.exit).toBe('repeating');
  });
});

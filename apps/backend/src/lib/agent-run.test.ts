import { describe, it, expect } from 'vitest';
import { agentRunOptions, wantsWeb , wantsMcp, allowWithMcp } from './agent-run.js';
import type { SandboxDriver } from './agent-loop.js';
import type { WebTools } from './web-tools.js';
import { PACK_SEEDS } from './pack-seeds.js';

const BUDGET = PACK_SEEDS[0]!.budget;
const RESEARCHER_BUDGET = PACK_SEEDS.find((p) => p.slug === 'researcher')!.budget;

const sandbox = {} as SandboxDriver;
const web = { search: async () => [], fetchPage: async () => '', sources: {} } as unknown as WebTools;
const inputs = (over = {}) => ({ taskContext: 'do the thing', sandbox, ...over });

const researcher = {
  tools: ['web_search', 'fetch_web_page', 'write_file', 'finish'],
};

describe('assembling an agent run from a persona', () => {
  it('always carries the parts a caller cannot leave out', () => {
    const o = agentRunOptions(BUDGET, null, inputs({ memoryContext: 'the repo has a src/' }));
    expect(o.budget).toBe(BUDGET);
    expect(o.memoryContext).toBe('the repo has a src/');
    expect(o.taskContext).toBe('do the thing');
    expect(o.sandbox).toBe(sandbox);
  });

  it('reads pacing and withdraw off the budget, not the pack', () => {
    const o = agentRunOptions(RESEARCHER_BUDGET, researcher, inputs({ web }));
    expect(o.allowTools).toEqual(researcher.tools);
    expect(o.pacing).toEqual(RESEARCHER_BUDGET.run.pacing);
    expect(o.withdrawTools).toEqual({
      afterStep: RESEARCHER_BUDGET.run.withdraw!.afterStep,
      names: RESEARCHER_BUDGET.run.withdraw!.tools,
    });
  });

  it('leaves pacing/withdraw unset for a budget that declares none', () => {
    const o = agentRunOptions(BUDGET, { tools: [] }, inputs({ web }));
    expect(o.pacing).toBeUndefined();
    expect(o.withdrawTools).toBeUndefined();
  });

  /**
   * A pack granting nothing used to leave `allowTools` unset, which the loop read as "offer
   * everything" -- the opposite of what an empty grant list says. No pack at all is the different
   * case: there is no list to honour, so the loop keeps its own default.
   */
  it('grants nothing for a pack that grants nothing, and defers only when there is no pack', () => {
    expect(agentRunOptions(BUDGET, { tools: [] }, inputs({ web })).allowTools).toEqual([]);
    expect(agentRunOptions(BUDGET, null, inputs({ web })).allowTools).toBeUndefined();
  });

  it('offers the web only when the persona asked AND the caller could build it', () => {
    expect(agentRunOptions(BUDGET, researcher, inputs({ web })).web).toBe(web);
    expect(agentRunOptions(BUDGET, researcher, inputs()).web).toBeUndefined();
    expect(agentRunOptions(BUDGET, { tools: ['write_file'] }, inputs({ web })).web).toBeUndefined();
  });

  it('carries the pack it ran as, which is the provenance now', () => {
    expect(agentRunOptions(BUDGET, null, inputs()).ranAs).toBeUndefined();
    const ran = { packId: 'p1', slug: 'koala', packUpdatedAt: 'now', sampling: PACK_SEEDS[0]!.sampling, budget: BUDGET };
    expect(agentRunOptions(BUDGET, null, inputs({ ranAs: ran })).ranAs).toEqual(ran);
  });
});

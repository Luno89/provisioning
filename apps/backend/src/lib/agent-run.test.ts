import { describe, it, expect } from 'vitest';
import { agentRunOptions, wantsWeb , wantsMcp, allowWithMcp } from './agent-run.js';
import type { SandboxDriver } from './agent-loop.js';
import type { WebTools } from './web-tools.js';
import { PACK_SEEDS } from './pack-seeds.js';

const BUDGET = PACK_SEEDS[0]!.budget;

const sandbox = {} as SandboxDriver;
const web = { search: async () => [], fetchPage: async () => '', sources: {} } as unknown as WebTools;
const inputs = (over = {}) => ({ taskContext: 'do the thing', sandbox, ...over });

const researcher = {
  tools: ['web_search', 'fetch_web_page', 'write_file', 'finish'],
  workspace: {
    run: {
      maxSteps: 100,
      withdraw: { afterStep: 50, tools: ['web_search'] },
      pacing: [{ atRemaining: 50, message: 'write it now' }],
    },
  },
};

describe('assembling an agent run from a persona', () => {
  it('always carries the parts a caller cannot leave out', () => {
    const o = agentRunOptions(BUDGET, null, inputs({ memoryContext: 'the repo has a src/' }));
    expect(o.budget).toBe(BUDGET);
    expect(o.memoryContext).toBe('the repo has a src/');
    expect(o.taskContext).toBe('do the thing');
    expect(o.sandbox).toBe(sandbox);
  });

  it('reads the whole environment off the persona', () => {
    const o = agentRunOptions(BUDGET, researcher, inputs({ web }));
    expect(o.allowTools).toEqual(researcher.tools);
    expect(o.maxSteps).toBe(100);
    expect(o.pacing).toEqual([{ atRemaining: 50, message: 'write it now' }]);
    expect(o.withdrawTools).toEqual({ afterStep: 50, names: ['web_search'] });
  });

  it('leaves the loop defaults alone for a persona that declares nothing', () => {
    const o = agentRunOptions(BUDGET, { tools: [], workspace: {} }, inputs({ web }));
    expect(o.maxSteps).toBeUndefined();
    expect(o.pacing).toBeUndefined();
    expect(o.withdrawTools).toBeUndefined();
  });

  /**
   * A pack granting nothing used to leave `allowTools` unset, which the loop read as "offer
   * everything" -- the opposite of what an empty grant list says. No pack at all is the different
   * case: there is no list to honour, so the loop keeps its own default.
   */
  it('grants nothing for a pack that grants nothing, and defers only when there is no pack', () => {
    expect(agentRunOptions(BUDGET, { tools: [], workspace: {} }, inputs({ web })).allowTools).toEqual([]);
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

describe('whether a persona needs the web', () => {
  it('is read from the toolset, not a second flag', () => {
    expect(wantsWeb(researcher)).toBe(true);
    expect(wantsWeb({ tools: ['fetch_web_page'] })).toBe(true);
    expect(wantsWeb({ tools: ['run_command', 'finish'] })).toBe(false);
    expect(wantsWeb({ tools: [] })).toBe(false);
    expect(wantsWeb(null)).toBe(false);
  });
});

describe('a persona reaching the services this harness built', () => {
  const remote = (name: string) => ({
    type: 'function' as const,
    function: { name, description: `[weather] ${name}`, parameters: { type: 'object', properties: {} } },
  });

  it('asks for nothing unless the persona named something', () => {
    expect(wantsMcp(null)).toEqual([]);
    expect(wantsMcp({ workspace: {} } as never)).toEqual([]);
    expect(wantsMcp({ mcp: ['weather'] } as never)).toEqual(['weather']);
  });

  it('lets an allowlisting persona still reach a remote tool', () => {
    expect(allowWithMcp(['run_command', 'finish'], ['weather__get-forecast']))
      .toEqual(['run_command', 'finish', 'weather__get-forecast']);
  });

  it('leaves an unrestricted persona unrestricted', () => {
    expect(allowWithMcp([], ['weather__get-forecast'])).toEqual([]);
  });

  it('passes the tools and the handler through to the loop', () => {
    const callRemote = async () => undefined;
    const opts = agentRunOptions(BUDGET, { tools: ['run_command'], workspace: { mcp: ['weather'],} } as never, {
      taskContext: 'x', sandbox: {} as never,
      remoteTools: [remote('weather__get-forecast')],
      remoteToolNames: ['weather__get-forecast'],
      callRemote,
    });
    expect(opts.remoteTools).toHaveLength(1);
    expect(opts.callRemote).toBe(callRemote);
    expect(opts.allowTools).toContain('weather__get-forecast');
  });

  it('offers nothing when the caller resolved nothing', () => {
    const opts = agentRunOptions(BUDGET, { mcp: ['weather'] } as never, {
      taskContext: 'x', sandbox: {} as never,
    });
    expect(opts.remoteTools).toBeUndefined();
    expect(opts.callRemote).toBeUndefined();
  });
});

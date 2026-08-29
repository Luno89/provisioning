import { describe, it, expect } from 'vitest';
import { agentRunOptions, wantsWeb , wantsMcp, allowWithMcp } from './agent-run.js';
import type { SandboxDriver } from './agent-loop.js';
import type { WebTools } from './web-tools.js';

const sandbox = {} as SandboxDriver;
const web = { search: async () => [], fetchPage: async () => '', sources: {} } as unknown as WebTools;
const inputs = (over = {}) => ({ taskContext: 'do the thing', sandbox, overrides: {}, ...over });

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
    const o = agentRunOptions(null, inputs({ overrides: { temperature: 0.3 }, memoryContext: 'the repo has a src/' }));
    expect(o.overrides).toEqual({ temperature: 0.3 });
    expect(o.memoryContext).toBe('the repo has a src/');
    expect(o.taskContext).toBe('do the thing');
    expect(o.sandbox).toBe(sandbox);
  });

  it('reads the whole environment off the persona', () => {
    const o = agentRunOptions(researcher, inputs({ web }));
    expect(o.allowTools).toEqual(researcher.tools);
    expect(o.maxSteps).toBe(100);
    expect(o.pacing).toEqual([{ atRemaining: 50, message: 'write it now' }]);
    expect(o.withdrawTools).toEqual({ afterStep: 50, names: ['web_search'] });
  });

  it('leaves the loop defaults alone for a persona that declares nothing', () => {
    const o = agentRunOptions({ tools: [], workspace: {} }, inputs({ web }));
    expect(o.allowTools).toBeUndefined();
    expect(o.maxSteps).toBeUndefined();
    expect(o.pacing).toBeUndefined();
    expect(o.withdrawTools).toBeUndefined();
  });

  it('offers the web only when the persona asked AND the caller could build it', () => {
    expect(agentRunOptions(researcher, inputs({ web })).web).toBe(web);
    expect(agentRunOptions(researcher, inputs()).web).toBeUndefined();
    expect(agentRunOptions({ tools: ['write_file'] }, inputs({ web })).web).toBeUndefined();
  });

  it('omits provenance rather than sending empty lists', () => {
    const bare = agentRunOptions(null, inputs());
    expect(bare.fromProfile).toBeUndefined();
    expect(bare.fromPersona).toBeUndefined();
    const with_ = agentRunOptions(null, inputs({ fromProfile: ['temperature'], fromPersona: [] }));
    expect(with_.fromProfile).toEqual(['temperature']);
    expect(with_.fromPersona).toBeUndefined();
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
    const opts = agentRunOptions({ tools: ['run_command'], workspace: { mcp: ['weather'],} } as never, {
      taskContext: 'x', overrides: {}, sandbox: {} as never,
      remoteTools: [remote('weather__get-forecast')],
      remoteToolNames: ['weather__get-forecast'],
      callRemote,
    });
    expect(opts.remoteTools).toHaveLength(1);
    expect(opts.callRemote).toBe(callRemote);
    expect(opts.allowTools).toContain('weather__get-forecast');
  });

  it('offers nothing when the caller resolved nothing', () => {
    const opts = agentRunOptions({ mcp: ['weather'] } as never, {
      taskContext: 'x', overrides: {}, sandbox: {} as never,
    });
    expect(opts.remoteTools).toBeUndefined();
    expect(opts.callRemote).toBeUndefined();
  });
});

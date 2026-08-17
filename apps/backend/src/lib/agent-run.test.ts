import { describe, it, expect } from 'vitest';
import { agentRunOptions, wantsWeb , wantsMcp, allowWithMcp } from './agent-run.js';
import type { SandboxDriver } from './agent-loop.js';
import type { WebTools } from './web-tools.js';

const sandbox = {} as SandboxDriver;
const web = { search: async () => [], fetchPage: async () => '', sources: {} } as unknown as WebTools;
const inputs = (over = {}) => ({ taskContext: 'do the thing', sandbox, overrides: {}, ...over });

const researcher = {
  scope: {
    tools: ['web_search', 'fetch_web_page', 'write_file', 'finish'],
    run: {
      maxSteps: 100,
      withdraw: { afterStep: 50, tools: ['web_search'] },
      pacing: [{ atRemaining: 50, message: 'write it now' }],
    },
  },
};

describe('assembling an agent run from a persona', () => {
  it('always carries the parts a caller cannot leave out', () => {
    /**
     * Editing one of the three hand-written copies of this dropped `overrides` and `memoryContext`,
     * which would have discarded the promoted profile and the memory bank on every leaf. These are
     * not optional and there is now one place to forget them.
     */
    const o = agentRunOptions(null, inputs({ overrides: { temperature: 0.3 }, memoryContext: 'the repo has a src/' }));
    expect(o.overrides).toEqual({ temperature: 0.3 });
    expect(o.memoryContext).toBe('the repo has a src/');
    expect(o.taskContext).toBe('do the thing');
    expect(o.sandbox).toBe(sandbox);
  });

  it('reads the whole environment off the persona', () => {
    const o = agentRunOptions(researcher, inputs({ web }));
    expect(o.allowTools).toEqual(researcher.scope.tools);
    expect(o.maxSteps).toBe(100);
    expect(o.pacing).toEqual([{ atRemaining: 50, message: 'write it now' }]);
    expect(o.withdrawTools).toEqual({ afterStep: 50, names: ['web_search'] });
  });

  it('leaves the loop defaults alone for a persona that declares nothing', () => {
    // Every run behaved this way before personas owned their environment, and a persona written
    // then must keep working.
    const o = agentRunOptions({ scope: {} }, inputs({ web }));
    expect(o.allowTools).toBeUndefined();
    expect(o.maxSteps).toBeUndefined();
    expect(o.pacing).toBeUndefined();
    expect(o.withdrawTools).toBeUndefined();
  });

  it('offers the web only when the persona asked AND the caller could build it', () => {
    /**
     * Both conditions, because each has been wrong alone. A flag with nothing wired behind it is
     * how the Lab spent a whole run reporting it had no internet access; tools handed to a persona
     * that never listed them is how the Framer spent its budget searching.
     */
    expect(agentRunOptions(researcher, inputs({ web })).web).toBe(web);
    expect(agentRunOptions(researcher, inputs()).web).toBeUndefined();
    expect(agentRunOptions({ scope: { tools: ['write_file'] } }, inputs({ web })).web).toBeUndefined();
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
    // Two fields that must agree are two fields that eventually will not.
    expect(wantsWeb(researcher)).toBe(true);
    expect(wantsWeb({ scope: { tools: ['fetch_web_page'] } })).toBe(true);
    expect(wantsWeb({ scope: { tools: ['run_command', 'finish'] } })).toBe(false);
    expect(wantsWeb({ scope: {} })).toBe(false);
    expect(wantsWeb(null)).toBe(false);
  });
});

describe('a persona reaching the services this harness built', () => {
  const remote = (name: string) => ({
    type: 'function' as const,
    function: { name, description: `[weather] ${name}`, parameters: { type: 'object', properties: {} } },
  });

  it('asks for nothing unless the persona named something', () => {
    /**
     * Opt-in, never automatic. Every tool offered costs prompt tokens on EVERY turn, so a persona
     * that gained eleven of them because somebody deployed something unrelated would get slower and
     * more expensive with no change anybody made.
     */
    expect(wantsMcp(null)).toEqual([]);
    expect(wantsMcp({ scope: {} } as never)).toEqual([]);
    expect(wantsMcp({ scope: { mcp: ['weather'] } } as never)).toEqual(['weather']);
  });

  it('lets an allowlisting persona still reach a remote tool', () => {
    /**
     * The subtle one. `allowTools` filters by name, and a remote tool's name is not knowable when
     * the persona is written — it depends on what has been deployed. Without appending them, a
     * persona that restricts its toolset gets the remote tools offered and then filtered straight
     * back out, which looks like the server is missing.
     */
    expect(allowWithMcp(['run_command', 'finish'], ['weather__get-forecast']))
      .toEqual(['run_command', 'finish', 'weather__get-forecast']);
  });

  it('leaves an unrestricted persona unrestricted', () => {
    // An empty allowlist means "everything"; appending to it would turn that into a restriction.
    expect(allowWithMcp([], ['weather__get-forecast'])).toEqual([]);
  });

  it('passes the tools and the handler through to the loop', () => {
    const callRemote = async () => undefined;
    const opts = agentRunOptions({ scope: { mcp: ['weather'], tools: ['run_command'] } } as never, {
      taskContext: 'x', overrides: {}, sandbox: {} as never,
      remoteTools: [remote('weather__get-forecast')],
      remoteToolNames: ['weather__get-forecast'],
      callRemote,
    });
    expect(opts.remoteTools).toHaveLength(1);
    expect(opts.callRemote).toBe(callRemote);
    // And the allowlist grew to admit it.
    expect(opts.allowTools).toContain('weather__get-forecast');
  });

  it('offers nothing when the caller resolved nothing', () => {
    // A persona that named a server which is not running must not end up with an empty `remoteTools`
    // key that later code has to special-case.
    const opts = agentRunOptions({ scope: { mcp: ['weather'] } } as never, {
      taskContext: 'x', overrides: {}, sandbox: {} as never,
    });
    expect(opts.remoteTools).toBeUndefined();
    expect(opts.callRemote).toBeUndefined();
  });
});

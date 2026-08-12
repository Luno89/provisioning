import { describe, it, expect } from 'vitest';
import { agentRunOptions, wantsWeb } from './agent-run.js';
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

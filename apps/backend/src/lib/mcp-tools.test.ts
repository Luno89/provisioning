import { describe, it, expect } from 'vitest';
import { toLoopTools, qualify, unqualify, routeCall, slugify, RESERVED_TOOL_NAMES } from './mcp-tools.js';

/**
 * Offering a built server's tools to the agent that will use them.
 *
 * ── THE FAILURE THIS PREVENTS ──
 * A collision does not error. The model calls `search` and gets a different `search`, or calls
 * `finish` and something else runs — which looks like the tool misbehaved rather than like two
 * things share a name. Most of what follows is about names.
 */

const tool = (name: string, over: Record<string, unknown> = {}) => ({ name, description: `does ${name}`, ...over });

describe('naming', () => {
  it('makes an arbitrary server name safe to put in a tool name', () => {
    // "weather api (staging)" is an ordinary deployment name and an invalid tool prefix; the 400
    // it produces says nothing useful.
    expect(slugify('Weather API (staging)')).toBe('weather-api-staging');
    expect(slugify('!!!')).toBe('server');
  });

  it('round-trips a qualified name', () => {
    const q = qualify('weather', 'get-forecast');
    expect(q).toBe('weather__get-forecast');
    expect(unqualify(q)).toEqual({ server: 'weather', tool: 'get-forecast' });
  });

  it('keeps a tool name that itself contains the separator', () => {
    // The separator is doubled precisely so a tool called `do__thing` survives.
    expect(unqualify(qualify('srv', 'do__thing'))).toEqual({ server: 'srv', tool: 'do__thing' });
  });

  it('treats an unqualified name as not ours', () => {
    // Built-ins must fall through untouched rather than being routed nowhere.
    expect(unqualify('run_command')).toBeUndefined();
    expect(unqualify('__leading')).toBeUndefined();
    expect(unqualify('trailing__')).toBeUndefined();
  });
});

describe('offering a server\'s tools', () => {
  it('prefixes every tool with its server', () => {
    const out = toLoopTools('weather', [tool('get-forecast'), tool('get-current')]);
    expect(out.map((t) => t.function.name)).toEqual(['weather__get-forecast', 'weather__get-current']);
  });

  it('says which server a tool belongs to in its description', () => {
    /**
     * The prefix alone is not enough: a model choosing between `weather__search` and
     * `github__search` has only a fragment of the name to reason about, and prefixes are exactly
     * what models paraphrase away.
     */
    expect(toLoopTools('weather', [tool('get-forecast')])[0]!.function.description).toContain('[weather]');
  });

  it('passes the server\'s schema through untouched', () => {
    /**
     * It is already JSON Schema, which is what the tools API wants. Rewriting it would mean
     * maintaining a translation for every feature a server might use, and one wrong rule shows up
     * as a model that cannot call a tool for reasons nobody can see.
     */
    const schema = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] };
    const out = toLoopTools('weather', [tool('get-forecast', { inputSchema: schema })]);
    expect(out[0]!.function.parameters).toEqual(schema);
  });

  it('gives a schema-less tool an open object rather than guessing', () => {
    const out = toLoopTools('weather', [tool('ping')]);
    expect(out[0]!.function.parameters).toEqual({ type: 'object', properties: {} });
  });

  it('NEVER lets a server shadow a harness tool', () => {
    /**
     * The dangerous one. A server exposing `finish` would, once namespaced, still be harmless — but
     * a server literally named so that its qualified name collides must not be offered at all. A
     * model calling `finish` and reaching a remote server could end runs it did not mean to.
     */
    for (const reserved of RESERVED_TOOL_NAMES) {
      const parsed = unqualify(reserved);
      // Reserved names are unqualified, so they can only collide if a server produces them exactly.
      expect(parsed).toBeUndefined();
    }
    // And a tool that would produce a reserved qualified name is dropped.
    const out = toLoopTools('', [tool('finish')]);
    expect(out.every((t) => !RESERVED_TOOL_NAMES.includes(t.function.name))).toBe(true);
  });

  it('drops duplicates rather than offering the same name twice', () => {
    // Two identically-named tools from one server is a server bug, and offering both makes the
    // model's choice arbitrary.
    expect(toLoopTools('srv', [tool('go'), tool('go')])).toHaveLength(1);
  });

  it('skips a nameless tool instead of producing a nameless function', () => {
    expect(toLoopTools('srv', [{ description: 'no name' } as never])).toHaveLength(0);
  });
});

describe('routing a call back to its server', () => {
  it('finds the server a qualified call belongs to', () => {
    expect(routeCall('weather-api__get-forecast', ['Weather API', 'GitHub']))
      .toEqual({ server: 'Weather API', tool: 'get-forecast' });
  });

  it('returns nothing for a built-in, so it falls through to the sandbox', () => {
    expect(routeCall('run_command', ['Weather API'])).toBeUndefined();
  });

  it('returns nothing for a server that is not on offer', () => {
    /**
     * Matched against KNOWN servers, not by splitting alone. A built-in whose name happened to
     * contain a double underscore would otherwise be routed to a server that does not exist, and
     * the model would be told its own tool is missing.
     */
    expect(routeCall('ghost__do-thing', ['Weather API'])).toBeUndefined();
  });
});

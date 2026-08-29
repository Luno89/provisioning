import { describe, it, expect } from 'vitest';
import { toLoopTools, qualify, unqualify, routeCall, slugify, RESERVED_TOOL_NAMES } from './mcp-tools.js';

const tool = (name: string, over: Record<string, unknown> = {}) => ({ name, description: `does ${name}`, ...over });

describe('naming', () => {
  it('makes an arbitrary server name safe to put in a tool name', () => {
    expect(slugify('Weather API (staging)')).toBe('weather-api-staging');
    expect(slugify('!!!')).toBe('server');
  });

  it('round-trips a qualified name', () => {
    const q = qualify('weather', 'get-forecast');
    expect(q).toBe('weather__get-forecast');
    expect(unqualify(q)).toEqual({ server: 'weather', tool: 'get-forecast' });
  });

  it('keeps a tool name that itself contains the separator', () => {
    expect(unqualify(qualify('srv', 'do__thing'))).toEqual({ server: 'srv', tool: 'do__thing' });
  });

  it('treats an unqualified name as not ours', () => {
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
    expect(toLoopTools('weather', [tool('get-forecast')])[0]!.function.description).toContain('[weather]');
  });

  it('passes the server\'s schema through untouched', () => {
    const schema = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] };
    const out = toLoopTools('weather', [tool('get-forecast', { inputSchema: schema })]);
    expect(out[0]!.function.parameters).toEqual(schema);
  });

  it('gives a schema-less tool an open object rather than guessing', () => {
    const out = toLoopTools('weather', [tool('ping')]);
    expect(out[0]!.function.parameters).toEqual({ type: 'object', properties: {} });
  });

  it('NEVER lets a server shadow a harness tool', () => {
    for (const reserved of RESERVED_TOOL_NAMES) {
      const parsed = unqualify(reserved);
      expect(parsed).toBeUndefined();
    }
    const out = toLoopTools('', [tool('finish')]);
    expect(out.every((t) => !RESERVED_TOOL_NAMES.includes(t.function.name))).toBe(true);
  });

  it('drops duplicates rather than offering the same name twice', () => {
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
    expect(routeCall('ghost__do-thing', ['Weather API'])).toBeUndefined();
  });
});

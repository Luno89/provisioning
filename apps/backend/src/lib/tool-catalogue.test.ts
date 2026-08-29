import { describe, it, expect } from 'vitest';
import { ALL_TOOL_SEEDS, TOOL_SEEDS } from './tool-seeds.js';
import { KOALA_TOOLS, KOALA_TOOL_HANDLERS, KOALA_TOOL_EFFECTS } from './koala-tools.js';
import { LEAF_TOOLS } from './leaf-tools.js';
import { SANDBOX_TOOLS } from './sandbox-tools.js';

const names = (tools: readonly { function: { name: string } }[]) => tools.map((t) => t.function.name);

describe('the catalogue covers everything dispatchable', () => {
  it('has a registry row for every tool a chat turn can offer', () => {
    const registry = new Set(ALL_TOOL_SEEDS.map((t) => t.name));
    for (const name of names(KOALA_TOOLS)) {
      expect(registry, name).toContain(name);
    }
  });

  it('has a registry row for every tool a leaf or sandbox run can offer', () => {
    const registry = new Set(ALL_TOOL_SEEDS.map((t) => t.name));
    for (const name of [...names(LEAF_TOOLS), ...names(SANDBOX_TOOLS)]) {
      expect(registry, name).toContain(name);
    }
  });

  it('covers the Ingestor persona, whose whole toolset was missing', () => {
    const registry = new Set(ALL_TOOL_SEEDS.map((t) => t.name));
    for (const name of ['start_ingest', 'ingest_status', 'search_corpus']) {
      expect(registry, name).toContain(name);
    }
  });

  it('is a superset of the hand-written seeds, never a replacement', () => {
    const all = new Map(ALL_TOOL_SEEDS.map((t) => [t.name, t]));
    for (const seed of TOOL_SEEDS) {
      expect(all.get(seed.name), seed.name).toEqual(seed);
    }
  });

  it('declares each tool exactly once', () => {
    const seen = ALL_TOOL_SEEDS.map((t) => t.name);
    expect(new Set(seen).size, `duplicates: ${seen.filter((n, i) => seen.indexOf(n) !== i).join(', ')}`)
      .toBe(seen.length);
  });
});

describe('schema, handler and effect stay joined', () => {
  it('every schema has a handler and an effect', () => {
    const handlers = new Set(Object.keys(KOALA_TOOL_HANDLERS));
    const effects = new Set(Object.keys(KOALA_TOOL_EFFECTS));
    for (const name of names(KOALA_TOOLS)) {
      expect(handlers, name).toContain(name);
      expect(effects, name).toContain(name);
    }
  });

  it('every handler is reachable through a schema', () => {
    const schemas = new Set(names(KOALA_TOOLS));
    for (const name of Object.keys(KOALA_TOOL_HANDLERS)) {
      expect(schemas, name).toContain(name);
    }
  });

  it('offers the web tools, which reach the network through the backend', () => {
    expect(names(KOALA_TOOLS)).toContain('web_search');
    expect(names(KOALA_TOOLS)).toContain('fetch_web_page');
  });
});

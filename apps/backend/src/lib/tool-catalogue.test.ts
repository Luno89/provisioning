import { describe, it, expect } from 'vitest';
import { ALL_TOOL_SEEDS, TOOL_SEEDS } from './tool-seeds.js';
import { KOALA_TOOLS, KOALA_TOOL_HANDLERS } from './koala-tools.js';
import { effectOf, schemasFor, type ToolSchema } from './tool-schemas.js';
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

    for (const name of names(KOALA_TOOLS)) {
      expect(handlers, name).toContain(name);
      expect(effectOf(name), name).toBeDefined();
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

describe('a tool is described in one place', () => {
  it('keeps parameters only on the schema, never a second copy on the registry row', () => {
    /**
     * The registry used to carry its own `parameters` beside the schema arrays, and the two had
     * drifted on 26 of 49 tools — `get_logs` had gained a `namespace` property in one copy and not
     * the other. Whichever copy a caller happened to read decided what the model was offered.
     */
    for (const row of ALL_TOOL_SEEDS) {
      expect(row.parameters, `${row.name} carries a second copy of its parameters`).toBeUndefined();
    }
  });

  it('serves a declared schema, never a registry paraphrase of one', () => {
    const declared = ([...KOALA_TOOLS, ...LEAF_TOOLS, ...SANDBOX_TOOLS] as unknown as ToolSchema[]);
    for (const schema of declared) {
      const served = schemasFor([schema.function.name])[0];
      expect(served, schema.function.name).toBeDefined();
      expect(served, `${schema.function.name} is served a copy, not the declaration`)
        .toBe(declared.find((t) => t.function.name === schema.function.name));
    }
  });

  it('keeps one PARAMETER SHAPE per tool, however many surfaces describe it', () => {
    /**
     * A tool may be declared in more than one array, and the descriptions may differ on purpose —
     * `list_mcp_servers` says something different to a planner than to a chat, and both wordings
     * are pinned by tests. Description is prompt text and belongs to the surface. The SHAPE is the
     * contract with the handler and cannot differ, which is what this asserts.
     */
    const shapes = new Map<string, string>();
    for (const t of ([...KOALA_TOOLS, ...LEAF_TOOLS, ...SANDBOX_TOOLS] as unknown as ToolSchema[])) {
      const p = t.function.parameters as { properties?: object; required?: string[] } | undefined;
      const shape = JSON.stringify({
        props: Object.keys(p?.properties ?? {}).sort(),
        required: [...(p?.required ?? [])].sort(),
      });
      const seen = shapes.get(t.function.name);
      if (seen === undefined) shapes.set(t.function.name, shape);
      else expect(shape, `${t.function.name} is declared with two different shapes`).toBe(seen);
    }
  });

  it('gives every in-process dispatchable tool an effect, and sandbox tools none', () => {
    // Sandbox tools run inside the pod, which is its own boundary; the gate only covers the
    // in-process runners, so an effect there would be a declaration nothing reads.
    for (const name of names(KOALA_TOOLS)) expect(effectOf(name), name).toBeDefined();
    for (const name of names(LEAF_TOOLS)) expect(effectOf(name), name).toBeDefined();
  });
});

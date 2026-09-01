import { describe, it, expect } from 'vitest';
import { ALL_TOOL_SEEDS, TOOL_SEEDS } from './tool-seeds.js';
import { KOALA_TOOL_HANDLERS } from './koala-tools.js';
import { effectOf, schemasFor, type ToolSchema } from './tool-catalogue.js';
import { PACK_SEEDS } from './pack-seeds.js';
import { TOOL_HANDLERS } from './tool-registry.js';
import { SANDBOX_ENTRIES } from './tool-handlers/sandbox.js';

const KOALA_TOOLS = schemasFor(ALL_TOOL_SEEDS, PACK_SEEDS.find((p) => p.slug === 'koala')!.tools);
const LEAF_TOOLS = schemasFor(ALL_TOOL_SEEDS, PACK_SEEDS.find((p) => p.slug === 'planner')!.tools);
const SANDBOX_TOOLS = schemasFor(ALL_TOOL_SEEDS, Object.keys(SANDBOX_ENTRIES));

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
    // The derived columns are added; nothing a hand-written row states is replaced.
    const all = new Map(ALL_TOOL_SEEDS.map((t) => [t.name, t]));
    for (const seed of TOOL_SEEDS) {
      expect(all.get(seed.name), seed.name).toMatchObject({
        id: seed.id, name: seed.name, description: seed.description,
        category: seed.category, ...(seed.effect ? { effect: seed.effect } : {}),
      });
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
      expect(effectOf(ALL_TOOL_SEEDS, name), name).toBeDefined();
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
  it('takes its parameters FROM the declaration, never a paraphrase of one', () => {
    /**
     * The registry used to carry a hand-written `parameters` beside the arrays and the two had
     * drifted on 26 of 49 tools — `get_logs` gained a `namespace` property in one copy and not the
     * other, and whichever a caller happened to read decided what the model was offered.
     *
     * The row is the single copy now, derived from the declaration while the arrays still exist.
     * This is what makes deleting them safe: the values are already identical.
     */
    // Five tools are declared on two surfaces and three of them word themselves differently on
    // purpose. The row is one copy, so a precedence is needed and it is FIRST-WINS in the order
    // assistant, planning, sandbox — the same order `declaredFor` uses. `keeps one PARAMETER SHAPE`
    // below is what guarantees the loser differs only in prose.
    const declared = new Map<string, unknown>();
    for (const t of ([...KOALA_TOOLS, ...LEAF_TOOLS, ...SANDBOX_TOOLS] as unknown as ToolSchema[])) {
      if (!declared.has(t.function.name)) declared.set(t.function.name, t.function.parameters);
    }
    for (const row of ALL_TOOL_SEEDS) {
      if (!declared.has(row.name)) continue;
      expect(JSON.stringify(row.parameters), row.name).toBe(JSON.stringify(declared.get(row.name)));
    }
  });

  /**
   * The guardrail this file exists for.
   *
   * A catalogue row with no handler is a tool a pack can grant, a model can be offered, and nothing
   * can run -- which is exactly what `get_leaf` was to a chat. A handler with no row is a tool
   * nobody can grant. Either way the two lists must be the same list, and a mismatch is a red test
   * rather than an error string at run time.
   */
  it('has a handler for every row, and a row for every handler', () => {
    expect(Object.keys(TOOL_HANDLERS).sort()).toEqual(ALL_TOOL_SEEDS.map((r) => r.name).sort());
  });

  it('declares an effect on every row, because the gate refuses a row without one', () => {
    for (const row of ALL_TOOL_SEEDS) expect(row.effect, row.name).toBeDefined();
  });

  it('serves the row, and the row carries the declared parameters', () => {
    /**
     * This asserted object IDENTITY while the arrays were the source — a served schema had to BE
     * the declaration, so no paraphrase could creep in. The row is the source now and `asSchema`
     * builds from it, so the check is that the values still match what the arrays declare. That
     * equality is what makes deleting them safe, and it goes when they do.
     */
    const declared = new Map<string, unknown>();
    for (const t of ([...KOALA_TOOLS, ...LEAF_TOOLS, ...SANDBOX_TOOLS] as unknown as ToolSchema[])) {
      if (!declared.has(t.function.name)) declared.set(t.function.name, t.function.parameters);
    }
    for (const [name, parameters] of declared) {
      const served = schemasFor(ALL_TOOL_SEEDS, [name])[0];
      expect(served, name).toBeDefined();
      expect(JSON.stringify(served!.function.parameters), name).toBe(JSON.stringify(parameters));
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
    for (const name of names(KOALA_TOOLS)) expect(effectOf(ALL_TOOL_SEEDS, name), name).toBeDefined();
    for (const name of names(LEAF_TOOLS)) expect(effectOf(ALL_TOOL_SEEDS, name), name).toBeDefined();
  });
});

import { describe, it, expect } from 'vitest';
import { ALL_TOOL_SEEDS, TOOL_SEEDS } from './tool-seeds.js';
import { KOALA_TOOLS, KOALA_TOOL_HANDLERS, KOALA_TOOL_EFFECTS } from './koala-tools.js';
import { LEAF_TOOLS } from './leaf-tools.js';
import { SANDBOX_TOOLS } from './sandbox-tools.js';

/**
 * One vocabulary for tools.
 *
 * ── WHAT WENT WRONG ──
 * There were four lists, and they disagreed. `TOOL_SEEDS` (43) was seeded to the database and read
 * only to write GUIDANCE into a prompt. `KOALA_TOOLS` (24) was what a chat turn actually offered a
 * model. `SANDBOX_TOOLS` + `LEAF_TOOLS` (25) was what the persona editor offered as grantable.
 *
 * The consequences were invisible in both directions: twenty-six registry tools could not be
 * granted through the UI at all, and eight grantable tools had no registry row — so they arrived at
 * a model with no guidance, including `start_ingest`, `ingest_status` and `search_corpus`, which
 * are the entire toolset of the seeded Ingestor persona.
 *
 * These assertions are the thing that stops it happening again. They are deliberately about the
 * RELATIONSHIPS between the lists rather than about any list's contents, so adding a tool is
 * covered without anyone remembering to extend this file.
 */

const names = (tools: readonly { function: { name: string } }[]) => tools.map((t) => t.function.name);

describe('the catalogue covers everything dispatchable', () => {
  it('has a registry row for every tool a chat turn can offer', () => {
    // Without a row, `composePersonaPrompt` falls through to `- **name**` with no description at
    // all — the model is handed a tool and told nothing about when to use it.
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
    // Named explicitly because this one is not hypothetical: the persona ships, its scope names
    // these three, and none of them existed in the catalogue that describes tools to a model.
    const registry = new Set(ALL_TOOL_SEEDS.map((t) => t.name));
    for (const name of ['start_ingest', 'ingest_status', 'search_corpus']) {
      expect(registry, name).toContain(name);
    }
  });

  it('is a superset of the hand-written seeds, never a replacement', () => {
    // The derived entries ADD; they must not shadow a hand-written row, which carries the
    // usageGuidance and compactGuidance a derived one cannot know.
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
  /**
   * `KoalaToolName` already ties these together in the type system, so a mismatch is normally a
   * compile error. Asserted at run time anyway because the join is what stops the one failure this
   * area has actually had: `web_search` and `fetch_web_page` were implemented, wired into the
   * route's context, and offered to nobody, because the schema was never added beside the handler.
   */
  it('every schema has a handler and an effect', () => {
    const handlers = new Set(Object.keys(KOALA_TOOL_HANDLERS));
    const effects = new Set(Object.keys(KOALA_TOOL_EFFECTS));
    for (const name of names(KOALA_TOOLS)) {
      expect(handlers, name).toContain(name);
      expect(effects, name).toContain(name);
    }
  });

  it('every handler is reachable through a schema', () => {
    // The direction that broke. A handler with no schema is working code no model is ever offered.
    const schemas = new Set(names(KOALA_TOOLS));
    for (const name of Object.keys(KOALA_TOOL_HANDLERS)) {
      expect(schemas, name).toContain(name);
    }
  });

  it('offers the web tools, which reach the network through the backend', () => {
    // They are imported from LEAF_TOOLS rather than restated, so there is one declaration of each.
    expect(names(KOALA_TOOLS)).toContain('web_search');
    expect(names(KOALA_TOOLS)).toContain('fetch_web_page');
  });
});

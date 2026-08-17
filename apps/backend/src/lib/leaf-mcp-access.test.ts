import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { normaliseLeafInput } from './leaf-input.js';
import { LEAF_TOOLS } from './leaf-tools.js';
import { wantsMcp } from './agent-run.js';
import { PLAN_SYSTEM_PROMPT } from './plan-mode.js';

/**
 * A leaf being able to call the server the plan just built.
 *
 * ── WHY NOTHING COULD ──
 * `wantsMcp` read `persona.scope.mcp` and nothing else, and a persona is written long before
 * anything is deployed — the server's name is not knowable then. Measured on the live instance,
 * every one of the nine personas had `scope.mcp: []`.
 *
 * So a plan whose final stage was "Call the deployed GitHub MCP server tools and verify real
 * responses" had no MCP tools at all, and could only guess at raw HTTP. The loop this platform
 * exists for — build a service, then use it — was open at the last step.
 */

describe('a leaf can name the servers it needs', () => {
  it('keeps the names through normalisation', () => {
    const out = normaliseLeafInput({ title: 'Verify it', mcp: ['github-mcp', 'weather'] });
    expect(out.mcp).toEqual(['github-mcp', 'weather']);
  });

  it('drops blanks and duplicates rather than passing them to a lookup', () => {
    const out = normaliseLeafInput({ title: 'x', mcp: ['github-mcp', '  ', 'github-mcp', ''] });
    expect(out.mcp).toEqual(['github-mcp']);
  });

  it('omits the field entirely when nothing was named', () => {
    // `exactOptionalPropertyTypes`: an explicit undefined is not the same as absent.
    expect(normaliseLeafInput({ title: 'x' })).not.toHaveProperty('mcp');
    expect(normaliseLeafInput({ title: 'x', mcp: [] })).not.toHaveProperty('mcp');
  });

  it('ignores a non-array, which is what a confused model sends', () => {
    expect(normaliseLeafInput({ title: 'x', mcp: 'github-mcp' as any })).not.toHaveProperty('mcp');
  });

  it('bounds the list', () => {
    const out = normaliseLeafInput({ title: 'x', mcp: Array.from({ length: 40 }, (_, i) => `s${i}`) });
    expect(out.mcp).toHaveLength(8);
  });

  it('is offered on propose_leaf, pointing at list_mcp_servers', () => {
    const params: any = LEAF_TOOLS.find((t) => t.function.name === 'propose_leaf')!.function.parameters;
    expect(params.properties.mcp).toBeTruthy();
    expect(params.properties.mcp.description).toMatch(/list_mcp_servers/);
    // The case that motivated it: the verifying leaf of a plan that builds a server.
    expect(params.properties.mcp.description).toMatch(/built earlier in this same plan/i);
  });
});

describe('the leaf\'s servers reach the executor', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const activity = readFileSync(join(here, '../activities/ExecuteLeafActivity.ts'), 'utf8');

  it('merges the leaf\'s names with the persona\'s instead of replacing them', () => {
    // A persona that grants a server must keep granting it; this only ever widens.
    expect(activity).toMatch(/new Set\(\[\.\.\.wantsMcp\(persona\), \.\.\.\(leaf\?\.mcp \?\? \[\]\)\]\)/);
  });

  it('still short-circuits when neither named anything', () => {
    // The common case must cost no registry call and no tokens.
    expect(activity).toMatch(/if \(!wanted\.length\) return \{\};/);
  });

  it('leaves the persona reader itself alone', () => {
    // wantsMcp stays a pure persona reader — the merge is the caller's job, so experiments and the
    // Lab that call it directly are unaffected.
    expect(wantsMcp({ scope: { mcp: ['a'] } } as any)).toEqual(['a']);
    expect(wantsMcp({ scope: {} } as any)).toEqual([]);
    expect(wantsMcp(null)).toEqual([]);
  });
});

describe('asking the planner for an end-to-end check', () => {
  /**
   * `reviewPlan` has warned `no-acceptance` all along and `AcceptRequestActivity` correctly SKIPS
   * rather than passing when no plan exists — the machinery was right and unused. On the observed
   * run `acceptance` was null and `acceptanceRunAt` said NEVER RAN: four leaves went green and
   * nothing exercised the thing they add up to.
   */
  it('names set_acceptance in the plan rules, where it was never mentioned', () => {
    expect(PLAN_SYSTEM_PROMPT).toMatch(/Call set_acceptance once/);
  });

  it('says what it is for, since a test suite alone reads as sufficient', () => {
    expect(PLAN_SYSTEM_PROMPT).toMatch(/only\s*\n?\s*.*proves the finished thing works|proves the finished thing works/);
    expect(PLAN_SYSTEM_PROMPT).toMatch(/RUNNING it and calling it for/);
  });
});

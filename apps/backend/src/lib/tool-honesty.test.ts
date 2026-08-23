import { describe, it, expect } from 'vitest';
import { renderSearchOutcome } from './web-tools.js';
import { buildAgentPrompt } from './sandbox-tools.js';

/**
 * ── THE SENTENCE THAT COST A PROJECT ITS BUDGET ──
 *
 * A Researcher was told `{"results":[{"snippet":"No results found"}]}` nineteen times. It responded
 * the only rational way — broadened from "OpenUI open-source UI generation framework LLM" down to
 * bare `HTML`, `CSS`, `LLM`, then looped two terms for fifteen steps and failed at 204K tokens.
 *
 * SearXNG answers those exact queries with ten results each. The backend was fine; the path to it
 * was not, and the fallback was rate-limited. An agent cannot reason its way out of a false
 * negative it has no way to detect, so the harness has to stop producing them.
 */

describe('what a search tells an agent', () => {
  it('says UNAVAILABLE when nothing looked, and that rephrasing will not help', () => {
    const out = renderSearchOutcome('OpenUI', { hits: [], unavailable: true }) as Record<string, string>;

    expect(out.unavailable).toBe(true);
    expect(out.note).toMatch(/rephrasing will not help/i);
    // The critical negative: it must not imply the topic is empty.
    expect(JSON.stringify(out)).not.toMatch(/no results found/i);
  });

  it('says NO MATCHES when a backend answered, and names which one', () => {
    const out = renderSearchOutcome('asdkjhasd', { hits: [], unavailable: false, answeredBy: 'searxng' }) as any;

    expect(out.unavailable).toBeUndefined();
    expect(out.source).toBe('searxng');
    // Here rephrasing IS the right move, and it says so.
    expect(out.note).toMatch(/different terms/i);
  });

  it('names the source even on success, so a silent downgrade is visible', () => {
    // SearXNG unreachable → DuckDuckGo answers. Both look like "a search worked" without this.
    const out = renderSearchOutcome('x', {
      hits: [{ title: 't', snippet: 's', url: 'https://x.dev' }],
      unavailable: false,
      answeredBy: 'duckduckgo',
    }) as any;

    expect(out.source).toBe('duckduckgo');
    expect(out.results).toHaveLength(1);
  });

  it('never renders the two cases identically', () => {
    const down = JSON.stringify(renderSearchOutcome('q', { hits: [], unavailable: true }));
    const empty = JSON.stringify(renderSearchOutcome('q', { hits: [], unavailable: false, answeredBy: 'searxng' }));

    expect(down).not.toBe(empty);
  });
});

describe('what the prompt says about the network', () => {
  /**
   * `describeSandbox` has an accurate branch, written after a Builder confidently ran `npm install`
   * against a registry it could not reach. `buildAgentPrompt` called it with the image alone, so
   * `egress` was always undefined and the accurate branch could never run — every agent was told it
   * had no network whatever its NetworkPolicy said.
   */
  it('tells an agent with no egress that it has no network', () => {
    expect(buildAgentPrompt('node', 'do the thing', 40)).toMatch(/NO outbound network/);
  });

  it('names what an agent with a binding can actually reach', () => {
    const prompt = buildAgentPrompt('node', 'do the thing', 40, {
      egress: [{ namespace: 'koala-vectors', ports: [6333] }],
    });

    expect(prompt).toMatch(/koala-vectors/);
    expect(prompt).toMatch(/port 6333/);
    // The blanket denial must be gone: it is now false, and an agent that believes it will not use
    // the database it was given.
    expect(prompt).not.toMatch(/NO outbound network beyond DNS/);
  });
});

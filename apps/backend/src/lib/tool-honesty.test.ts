import { describe, it, expect } from 'vitest';
import { renderSearchOutcome } from './web-tools.js';
import { buildAgentPrompt } from './sandbox-tools.js';
import { WORKSPACE_IMAGE_SEEDS as IMAGES } from './workspace-image-seeds.js';

describe('what a search tells an agent', () => {
  it('says UNAVAILABLE when nothing looked, and that rephrasing will not help', () => {
    const out = renderSearchOutcome('OpenUI', { hits: [], unavailable: true }) as Record<string, string>;

    expect(out.unavailable).toBe(true);
    expect(out.note).toMatch(/rephrasing will not help/i);
    expect(JSON.stringify(out)).not.toMatch(/no results found/i);
  });

  it('says NO MATCHES when a backend answered, and names which one', () => {
    const out = renderSearchOutcome('asdkjhasd', { hits: [], unavailable: false, answeredBy: 'searxng' }) as any;

    expect(out.unavailable).toBeUndefined();
    expect(out.source).toBe('searxng');
    expect(out.note).toMatch(/different terms/i);
  });

  it('names the source even on success, so a silent downgrade is visible', () => {
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
  it('tells an agent with no egress that it has no network', () => {
    expect(buildAgentPrompt(IMAGES, 'node', 'do the thing', 40)).toMatch(/NO outbound network/);
  });

  it('names what an agent with a binding can actually reach', () => {
    const prompt = buildAgentPrompt(IMAGES, 'node', 'do the thing', 40, {
      egress: [{ namespace: 'koala-vectors', ports: [6333] }],
    });

    expect(prompt).toMatch(/koala-vectors/);
    expect(prompt).toMatch(/port 6333/);
    expect(prompt).not.toMatch(/NO outbound network beyond DNS/);
  });
});

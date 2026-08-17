import { describe, it, expect } from 'vitest';
import { extractProposals } from './plan-mode.js';
import { EXTRACTION_SCHEMA, EXTRACTION_SYSTEM_PROMPT } from './extraction.js';

/**
 * The fields a plan writes surviving the trip to a leaf.
 *
 * ── WHAT DELETED THEM ──
 * Two proposal readers exist, and the CONSTRAINED one wins:
 *
 *     const fromProse = extracted?.length ? extracted : extractProposals(reply);
 *
 * `extracted` comes from a second model call with a JSON schema of exactly `{title, body}`. So a
 * field added to the prose parser was still dropped whenever that extractor produced anything.
 *
 * Observed on a live planning turn. The model wrote, correctly and unprompted:
 *
 *     {"title":"Verify github-mcp server tools by calling them for real",
 *      "persona":"Builder","mcp":["github-mcp"]}
 *
 * and the leaf arrived with persona=NONE and mcp=None — unacceptable by the persona guard, and with
 * no tools for the server it was created to call.
 */

describe('the extractor carries what it must not decide', () => {
  const props: any = (EXTRACTION_SCHEMA as any).properties.leaves.items.properties;

  it('declares persona and mcp in its schema', () => {
    // Constrained decoding: a field absent here cannot appear in the output at all.
    expect(props.persona).toBeTruthy();
    expect(props.mcp).toBeTruthy();
    expect(props.mcp.type).toBe('array');
  });

  it('still requires only a title', () => {
    // Requiring them would make the extractor INVENT a persona, which is the opposite failure.
    expect((EXTRACTION_SCHEMA as any).properties.leaves.items.required).toEqual(['title']);
  });

  it('tells it to copy rather than choose', () => {
    expect(EXTRACTION_SYSTEM_PROMPT).toMatch(/Copy `persona` and `mcp` exactly/);
    expect(EXTRACTION_SYSTEM_PROMPT).toMatch(/Omit them if it did not/);
  });
});

describe('the prose parser, on the block the model actually wrote', () => {
  const reply = '```json\n' + JSON.stringify({
    leaves: [{
      title: 'Verify github-mcp server tools by calling them for real',
      body: 'Call all three tools with real inputs.',
      persona: 'Builder',
      mcp: ['github-mcp'],
    }],
    serviceName: 'github-mcp',
  }) + '\n```';

  it('keeps both fields', () => {
    const [p] = extractProposals(reply);
    expect(p!.persona).toBe('Builder');
    expect(p!.mcp).toEqual(['github-mcp']);
  });

  it('drops blanks and duplicates from mcp', () => {
    const [p] = extractProposals('```json{"leaves":[{"title":"x","mcp":["a"," ","a",""]}]}```');
    expect(p!.mcp).toEqual(['a']);
  });

  it('omits mcp entirely rather than sending an empty array', () => {
    const [p] = extractProposals('```json{"leaves":[{"title":"x"}]}```');
    expect(p).not.toHaveProperty('mcp');
  });

  it('ignores a non-array mcp', () => {
    const [p] = extractProposals('```json{"leaves":[{"title":"x","mcp":"github-mcp"}]}```');
    expect(p).not.toHaveProperty('mcp');
  });
});

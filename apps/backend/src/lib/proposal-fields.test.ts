import { describe, it, expect } from 'vitest';
import { extractProposals } from './plan-mode.js';
import { EXTRACTION_SCHEMA, EXTRACTION_SYSTEM_PROMPT } from './extraction.js';
import { LEAF_TOOLS } from './leaf-tools.js';

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
    expect(EXTRACTION_SYSTEM_PROMPT).toMatch(/Copy `persona`, `mcp` and `projectId` exactly/);
    expect(EXTRACTION_SYSTEM_PROMPT).toMatch(/Omit any it did not/);
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

describe('the project a plan says the work belongs in', () => {
  /**
   * ── THE ROUND TRIP THAT DID NOT HAPPEN ──
   * The planner read list_mcp_servers, correctly said "No need to rebuild it", quoted the project
   * the running server is built from — and then never pointed a single leaf at it. `set_leaf_project`
   * existed, the tool result told it to use it, and it did not. The work went to a fresh repository
   * and produced a second service answering to the same name.
   *
   * Declared at proposal time now, beside `persona` and `mcp`, because that is the one moment the
   * planner has the id in hand. The same lesson as personas: a field that needs a follow-up call is
   * a field that is sometimes never set, and nothing says so.
   */
  it('is offered on propose_leaf, pointing at where the id comes from', () => {
    const params: any = LEAF_TOOLS.find((t) => t.function.name === 'propose_leaf')!.function.parameters;
    expect(params.properties.projectId).toBeTruthy();
    expect(params.properties.projectId.description).toMatch(/list_mcp_servers/);
    expect(params.properties.projectId.description).toMatch(/CHANGES something that already exists/);
  });

  it('is carried by the prose parser', () => {
    const [p] = extractProposals('```json{"leaves":[{"title":"Verify it","projectId":"p-9"}]}```');
    expect(p!.projectId).toBe('p-9');
  });

  it('is declared in the constrained extractor, which wins over the parser', () => {
    const props: any = (EXTRACTION_SCHEMA as any).properties.leaves.items.properties;
    expect(props.projectId).toBeTruthy();
    expect(EXTRACTION_SYSTEM_PROMPT).toMatch(/projectId/);
  });

  it('is omitted rather than sent empty', () => {
    const [p] = extractProposals('```json{"leaves":[{"title":"x","projectId":"  "}]}```');
    expect(p).not.toHaveProperty('projectId');
  });

  it('ignores a non-string', () => {
    const [p] = extractProposals('```json{"leaves":[{"title":"x","projectId":{"id":"p-9"}}]}```');
    expect(p).not.toHaveProperty('projectId');
  });
});

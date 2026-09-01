import { describe, it, expect } from 'vitest';
import { extractProposals } from './plan-mode.js';
import { EXTRACTION_SCHEMA, EXTRACTION_SYSTEM_PROMPT } from './extraction.js';
import { ALL_TOOL_SEEDS } from './tool-seeds.js';
import { schemasFor } from './tool-catalogue.js';
import { PACK_SEEDS } from './pack-seeds.js';

const BUDGET = PACK_SEEDS[0]!.budget;

const LEAF_TOOLS = schemasFor(ALL_TOOL_SEEDS, PACK_SEEDS.find((p) => p.slug === 'planner')!.tools);

describe('the extractor carries what it must not decide', () => {
  const props: any = (EXTRACTION_SCHEMA as any).properties.leaves.items.properties;

  it('declares persona and mcp in its schema', () => {
    expect(props.persona).toBeTruthy();
    expect(props.mcp).toBeTruthy();
    expect(props.mcp.type).toBe('array');
  });

  it('still requires only a title', () => {
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
    const [p] = extractProposals(reply, BUDGET.proposalsPerReply);
    expect(p!.persona).toBe('Builder');
    expect(p!.mcp).toEqual(['github-mcp']);
  });

  it('drops blanks and duplicates from mcp', () => {
    const [p] = extractProposals('```json{"leaves":[{"title":"x","mcp":["a"," ","a",""]}]}```', BUDGET.proposalsPerReply);
    expect(p!.mcp).toEqual(['a']);
  });

  it('omits mcp entirely rather than sending an empty array', () => {
    const [p] = extractProposals('```json{"leaves":[{"title":"x"}]}```', BUDGET.proposalsPerReply);
    expect(p).not.toHaveProperty('mcp');
  });

  it('ignores a non-array mcp', () => {
    const [p] = extractProposals('```json{"leaves":[{"title":"x","mcp":"github-mcp"}]}```', BUDGET.proposalsPerReply);
    expect(p).not.toHaveProperty('mcp');
  });
});

describe('the project a plan says the work belongs in', () => {
  it('is offered on propose_leaf, pointing at where the id comes from', () => {
    const params: any = LEAF_TOOLS.find((t) => t.function.name === 'propose_leaf')!.function.parameters;
    expect(params.properties.projectId).toBeTruthy();
    expect(params.properties.projectId.description).toMatch(/list_mcp_servers/);
    expect(params.properties.projectId.description).toMatch(/CHANGES something that already exists/);
  });

  it('is carried by the prose parser', () => {
    const [p] = extractProposals('```json{"leaves":[{"title":"Verify it","projectId":"p-9"}]}```', BUDGET.proposalsPerReply);
    expect(p!.projectId).toBe('p-9');
  });

  it('is declared in the constrained extractor, which wins over the parser', () => {
    const props: any = (EXTRACTION_SCHEMA as any).properties.leaves.items.properties;
    expect(props.projectId).toBeTruthy();
    expect(EXTRACTION_SYSTEM_PROMPT).toMatch(/projectId/);
  });

  it('is omitted rather than sent empty', () => {
    const [p] = extractProposals('```json{"leaves":[{"title":"x","projectId":"  "}]}```', BUDGET.proposalsPerReply);
    expect(p).not.toHaveProperty('projectId');
  });

  it('ignores a non-string', () => {
    const [p] = extractProposals('```json{"leaves":[{"title":"x","projectId":{"id":"p-9"}}]}```', BUDGET.proposalsPerReply);
    expect(p).not.toHaveProperty('projectId');
  });
});

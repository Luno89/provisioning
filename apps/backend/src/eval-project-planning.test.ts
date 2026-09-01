import { describe, it, expect } from 'vitest';
import { extractProposals } from './lib/plan-mode.js';
import { PACK_SEEDS } from './lib/pack-seeds.js';
import { PERSONA_SEEDS } from './lib/persona-seeds.js';
import { buildExtractionPrompt, parseExtractionResult } from './lib/extraction.js';
import { WORKSPACE_IMAGE_SEEDS as IMAGES } from './lib/workspace-image-seeds.js';

const PLAN_CONTRACT = PACK_SEEDS.find((p) => p.slug === 'planner')!.prompt.sections.planning ?? '';

const BUDGET = PACK_SEEDS[0]!.budget;
const PLANNER_PERSONA = PERSONA_SEEDS.find((p) => p.name === 'Planner')!;

describe('Project Planning & Leaf Decomposition Rigorous Evaluator', () => {
  it('includes clear instructions in PLAN_CONTRACT for breaking down projects', () => {
    // Who the planner is lives on the persona; the shape of a proposal lives on the pack.
    expect(PLANNER_PERSONA.systemPrompt).toContain('You are the planner.');
    expect(PLAN_CONTRACT).toContain('{"leaves":[');
    expect(PLAN_CONTRACT).toContain('Short imperative title');
  });

  it('tells the planner it has no sandbox, which is what stopped it building', () => {
    expect(PLANNER_PERSONA.systemPrompt).toContain('YOU DO NOT BUILD');
  });

  it('handles reasoning monologues (<think>...</think>) preceding JSON proposal blocks', () => {
    const reasoningReply = `
<think>
The user wants an API client for GitHub to search codebases by framework.
I need to break this down into clear architectural components:
1. Authentication (OAuth + PAT)
2. Search query builder for GET /search/code
3. AST / framework identifier
4. Rate limiting and pagination middleware
Let's format these as a clean leaves JSON block.
</think>

Here is the plan to build the GitHub API client:

\`\`\`json
{
  "leaves": [
    {
      "title": "Implement GitHub OAuth and PAT Authentication Module",
      "body": "Create auth handler supporting Bearer token headers and rate-limit tracking."
    },
    {
      "title": "Create GitHub Code Search Endpoint Wrapper",
      "body": "Build GET /search/code query string builder for language and topic filters."
    },
    {
      "title": "Build Framework Detection AST Parser",
      "body": "Parse package.json and requirements.txt to detect framework versions."
    },
    {
      "title": "Add Exponential Backoff and Pagination Handler",
      "body": "Handle cursor pagination and secondary rate limit 403 responses."
    }
  ]
}
\`\`\`
`;

    const proposals = extractProposals(reasoningReply, BUDGET.proposalsPerReply);
    expect(proposals).toHaveLength(4);

    const imperativeVerbs = ['Implement', 'Create', 'Build', 'Add', 'Configure', 'Setup'];
    for (const prop of proposals) {
      const firstWord = prop.title.split(' ')[0];
      expect(imperativeVerbs).toContain(firstWord);
      expect(prop.body).toBeDefined();
      expect(prop.body!.length).toBeGreaterThan(10);
    }
  });

  it('rejects general Q&A prose turns and returns zero proposals', () => {
    const qaReply = `
GitHub's REST API exposes the \`/search/code\` endpoint which allows searching code by language, repo, or path.
To search for React projects, you can pass \`q=language:typescript+framework:react\`. Let me know if you want me to write code for this!
`;

    const proposals = extractProposals(qaReply, BUDGET.proposalsPerReply);
    expect(proposals).toHaveLength(0);
  });

  it('parses bare JSON extraction results without fences and enforces title caps', () => {
    const rawJson = JSON.stringify({
      leaves: [
        {
          title: 'Setup Redis connection pool with ioredis',
          body: 'Configures cluster node endpoints and healthcheck ping.',
        },
        {
          title: 'Implement Express cache middleware for GET routes',
          body: 'Intercepts response JSON and stores in Redis with configurable TTL.',
        },
      ],
    });

    const proposals = parseExtractionResult(rawJson, 8);
    expect(proposals).toHaveLength(2);
    expect(proposals[0]!.title).toBe('Setup Redis connection pool with ioredis');
    expect(proposals[1]!.title).toBe('Implement Express cache middleware for GET routes');
  });

  it('truncates oversized titles and bodies to safe limits', () => {
    const longTitle = 'Implement ' + 'a'.repeat(300);
    const longBody = 'Body ' + 'b'.repeat(5000);
    const rawJson = JSON.stringify({
      leaves: [{ title: longTitle, body: longBody }],
    });

    const proposals = parseExtractionResult(rawJson, 8);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.title.length).toBeLessThanOrEqual(200);
    expect(proposals[0]!.body!.length).toBeLessThanOrEqual(4000);
  });

  it('formats extraction prompt correctly from turn history window', () => {
    const turns = [
      { role: 'user', content: 'Let us plan out an API client for GitHub API.' },
      { role: 'assistant', content: 'Sure! I can help structure this into modules.' },
    ];
    const prompt = buildExtractionPrompt(turns);
    expect(prompt).toContain('User: Let us plan out an API client for GitHub API.');
    expect(prompt).toContain('Assistant: Sure! I can help structure this into modules.');
    expect(prompt).toContain('Extract the concrete work items.');
  });
});

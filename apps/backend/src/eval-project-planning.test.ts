import { describe, it, expect } from 'vitest';
import { extractProposals, PLAN_SYSTEM_PROMPT } from './lib/plan-mode.js';
import { buildExtractionPrompt, parseExtractionResult } from './lib/extraction.js';

describe('Project Planning & Leaf Decomposition Evaluator', () => {
  it('includes clear instructions in PLAN_SYSTEM_PROMPT for breaking down projects', () => {
    expect(PLAN_SYSTEM_PROMPT).toContain('You are helping plan a piece of work.');
    expect(PLAN_SYSTEM_PROMPT).toContain('{"leaves":[');
    expect(PLAN_SYSTEM_PROMPT).toContain('Short imperative title');
  });

  it('extracts structured project leaves from a model reply containing fenced JSON', () => {
    const mockReply = `
I have analyzed the request for building a GitHub API client to search for codebases by framework.

Here is the proposed architectural breakdown:

\`\`\`json
{
  "leaves": [
    {
      "title": "Implement GitHub OAuth and Personal Access Token Auth Module",
      "body": "Build authentication wrapper supporting Bearer token headers and rate-limit header parsing."
    },
    {
      "title": "Create GitHub Code Search API Client Endpoint",
      "body": "Implement GET /search/code query builder filtering by repository language and topic tags."
    },
    {
      "title": "Add Framework Classifier and AST Parser",
      "body": "Parse package.json and requirements.txt in retrieved repositories to identify specific framework versions."
    },
    {
      "title": "Build Pagination and Retry Middleware",
      "body": "Add automatic cursor pagination and exponential backoff for GitHub REST API secondary rate limits."
    }
  ]
}
\`\`\`
`;

    const proposals = extractProposals(mockReply);
    expect(proposals).toHaveLength(4);
    expect(proposals[0].title).toBe('Implement GitHub OAuth and Personal Access Token Auth Module');
    expect(proposals[1].title).toBe('Create GitHub Code Search API Client Endpoint');
    expect(proposals[2].title).toBe('Add Framework Classifier and AST Parser');
    expect(proposals[3].title).toBe('Build Pagination and Retry Middleware');
    expect(proposals[0].body).toContain('rate-limit');
  });

  it('parses bare JSON extraction result seamlessly', () => {
    const mockJson = JSON.stringify({
      leaves: [
        {
          title: 'Implement CLI Resource Auditor for K8s',
          body: 'Queries K8s pod spec limits and requests across all namespaces.',
        },
        {
          title: 'Generate Memory/CPU Utilization Report',
          body: 'Computes namespace totals and flags over-provisioned containers.',
        },
      ],
    });

    const proposals = parseExtractionResult(mockJson, 8);
    expect(proposals).toHaveLength(2);
    expect(proposals[0].title).toBe('Implement CLI Resource Auditor for K8s');
    expect(proposals[1].title).toBe('Generate Memory/CPU Utilization Report');
  });

  it('formats extraction prompt with turns', () => {
    const turns = [
      { role: 'user', content: 'Let us plan out an API client for GitHub API.' },
      { role: 'assistant', content: 'Sure! I can help structure this.' },
    ];
    const prompt = buildExtractionPrompt(turns);
    expect(prompt).toContain('User: Let us plan out an API client for GitHub API.');
    expect(prompt).toContain('Extract the concrete work items.');
  });
});

import { describe, it, expect } from 'vitest';
import { extractContinuityState } from './state-vector.js';
import { renderContinuityNotice } from './state-renderer.js';
import { DEFAULT_COMPACTION_CONFIG } from '../config.js';

describe('continuity state vector extraction', () => {
  it('preserves cumulative user directives across multiple turns', () => {
    const messages = [
      { role: 'user', content: 'Build a rate limiting service' },
      { role: 'assistant', content: 'Sure, I will use SQLite' },
      { role: 'user', content: 'Actually, please use Postgres instead of SQLite' },
      { role: 'assistant', content: 'Okay, switching to Postgres' },
      { role: 'user', content: 'Also ensure rate limits are keyed per API token' },
    ];

    const state = extractContinuityState(messages, DEFAULT_COMPACTION_CONFIG);
    expect(state.goal).toContain('Build a rate limiting service');
    expect(state.cumulativeUserDirectives).toHaveLength(2);
    expect(state.cumulativeUserDirectives[0]).toContain('Postgres instead of SQLite');
    expect(state.cumulativeUserDirectives[1]).toContain('keyed per API token');
  });

  it('tracks files created and modified', () => {
    const messages = [
      { role: 'user', content: 'Do work' },
      {
        role: 'assistant',
        toolCalls: [
          { name: 'write_file', args: JSON.stringify({ path: 'src/index.ts' }), ok: true },
          { name: 'create_file', args: JSON.stringify({ path: 'src/config.ts' }), ok: true },
        ],
      },
    ];

    const state = extractContinuityState(messages, DEFAULT_COMPACTION_CONFIG);
    expect(state.filesCreated).toContain('src/config.ts');
    expect(state.filesModified).toContain('src/index.ts');
  });

  it('captures negative knowledge and failed attempts', () => {
    const messages = [
      { role: 'user', content: 'Run test' },
      {
        role: 'assistant',
        toolCalls: [
          { name: 'run_tests', args: '{}', ok: false, digest: 'SyntaxError in test.ts' },
        ],
      },
      {
        role: 'tool',
        name: 'run_command',
        content: 'Error: Port 8080 already in use, exit code 1',
        ok: false,
      },
    ];

    const state = extractContinuityState(messages, DEFAULT_COMPACTION_CONFIG);
    expect(state.negativeKnowledge.length).toBeGreaterThanOrEqual(2);
    expect(state.negativeKnowledge[0]).toContain('SyntaxError in test.ts');
    expect(state.negativeKnowledge[1]).toContain('Port 8080 already in use');
  });

  it('renders a formatted markdown continuity notice', () => {
    const state = {
      goal: 'Add oauth2 authentication',
      cumulativeUserDirectives: ['Turn 3: Use PKCE flow'],
      filesCreated: ['src/oauth.ts'],
      filesModified: ['src/server.ts'],
      environmentFacts: ['Service endpoint: 3000'],
      negativeKnowledge: ['Tool "curl" failed: 401 Unauthorized'],
      recentDiscoveries: ['oauth → discovered client id'],
      openProposals: [],
      acceptedProposals: [],
    };

    const rendered = renderContinuityNotice(state);
    expect(rendered).toContain('### Primary Goal & Objective');
    expect(rendered).toContain('Add oauth2 authentication');
    expect(rendered).toContain('Use PKCE flow');
    expect(rendered).toContain('src/oauth.ts');
    expect(rendered).toContain('DO NOT REPEAT');
    expect(rendered).toContain('401 Unauthorized');
  });
});

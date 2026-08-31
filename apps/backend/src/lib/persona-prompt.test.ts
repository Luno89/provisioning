import { describe, it, expect } from 'vitest';
import { composePersonaPrompt } from './persona-prompt.js';
import { PACK_SEEDS } from './pack-seeds.js';

const BUDGET = PACK_SEEDS[0]!.budget;
const PROMPT = PACK_SEEDS[0]!.prompt;

/**
 * The nine sections composed around a persona's own prompt had no test at all, so nothing said what
 * a model was actually told. Written before moving them onto the pack, so the move is provably a
 * move: every string here is what the harness produced beforehand.
 */
const compose = (options: Parameters<typeof composePersonaPrompt>[3]) =>
  composePersonaPrompt(BUDGET, PROMPT, 'You are Koala.', options);

describe('who the model is told it is talking to', () => {
  it('tells an administrator it can see the whole cluster', () => {
    expect(compose({ isAdmin: true })).toContain(
      '## Platform Role: Administrator\n'
      + 'You are interacting with a cluster Administrator. You have cluster-wide visibility across all namespaces, '
      + 'including platform monitoring (Prometheus, Grafana, Alertmanager), logging (Loki), and git infrastructure (Gitea). '
      + 'You may inspect system services and diagnose cluster health directly.',
    );
  });

  it('names the namespaces an escalated session actually reaches', () => {
    expect(compose({ isEscalated: true, escalatedNamespaces: ['monitoring', 'kube-system'] })).toContain(
      '## Escalated Privileges: Active\n'
      + 'Elevated cluster access has been approved for this session. Scope includes system namespaces: monitoring, kube-system. '
      + 'You may inspect diagnostics, logs, and events within these namespaces.',
    );
  });

  it('falls back to the namespaces escalation normally covers', () => {
    expect(compose({ isEscalated: true })).toContain('system namespaces: monitoring, gitea.');
  });

  it('tells a standard tenant how to ask for more, but only if it can', () => {
    const canAsk = compose({ activeTools: ['request_escalated_privileges'] });
    expect(canAsk).toContain(
      '## Standard Tenant Boundaries\n'
      + 'You are operating with standard tenant privileges. If diagnosing an issue requires access to cluster system '
      + 'namespaces (e.g. monitoring, gitea, kube-system), call request_escalated_privileges with a clear, honest reason.',
    );
    expect(compose({ activeTools: [] })).not.toContain('Standard Tenant Boundaries');
  });

  it('says exactly one of the three, never two', () => {
    const both = compose({ isAdmin: true, isEscalated: true, activeTools: ['request_escalated_privileges'] });
    expect(both).toContain('Platform Role: Administrator');
    expect(both).not.toContain('Escalated Privileges: Active');
    expect(both).not.toContain('Standard Tenant Boundaries');
  });
});

describe('how the model is told to handle a secret', () => {
  const withSecrets = () => compose({ activeTools: ['request_secret'] });

  it('appears only when it has a secrets tool to use', () => {
    expect(withSecrets()).toContain('## Secrets & Configuration Runtime Model');
    expect(compose({ activeTools: ['get_logs'] })).not.toContain('Secrets & Configuration Runtime Model');
    expect(compose({ activeTools: ['inject_secret_to_pod'] })).toContain('Secrets & Configuration Runtime Model');
  });

  it('says never to take a secret through the chat', () => {
    expect(withSecrets()).toContain(
      '- When an application requires a sensitive token, password, or API key from the user, NEVER ask them to paste it in plaintext chat. Always call request_secret to display a secure UI card.',
    );
  });

  it('says an app reads env vars rather than calling a vault', () => {
    expect(withSecrets()).toContain('- Applications run in Kubernetes containers where all secrets and configuration are injected as standard environment variables.');
    expect(withSecrets()).toContain('Do NOT write code that calls external vault APIs directly from inside the app.');
  });
});

describe('the services section', () => {
  it('says none are deployed rather than listing nothing', () => {
    expect(compose({ servers: [] })).toContain('No services are deployed yet. Propose a project to build one.');
  });

  it('lists what can be hooked up, and marks what already is', () => {
    const out = compose({
      servers: [{ name: 'github', description: 'GitHub API' }, { name: 'weather' }] as never,
      enabledServers: ['github'],
    });
    expect(out).toContain('## Services You Can Hook Up (via enable_mcp_server)\n'
      + '- github: GitHub API — ENABLED, its tools are loaded\n'
      + '- weather');
  });

  it('says nothing at all when the caller did not look', () => {
    expect(compose({})).not.toContain('Services You Can Hook Up');
    expect(compose({})).not.toContain('No services are deployed yet');
  });
});

describe('recalled memories', () => {
  it('introduces them as lessons from previous runs', () => {
    expect(compose({ memoryContext: 'npm ci needs a lockfile' })).toContain(
      '## Recalled Platform & Project Memories\n'
      + 'Relevant lessons learned, environment facts, and proven patterns recalled from previous runs:\n\n'
      + 'npm ci needs a lockfile',
    );
  });

  it('is omitted for blank memory rather than left as an empty heading', () => {
    expect(compose({ memoryContext: '   ' })).not.toContain('Recalled Platform');
  });
});

describe('what context pressure does to the shape of the prompt', () => {
  const registry = [{
    id: 't', name: 'get_logs', category: 'assistant' as const, requiresBinaries: [],
    description: 'Read logs.', usageGuidance: 'Call it when something is broken.',
    compactGuidance: 'Read logs.',
  }];
  const at = (fraction: number) => {
    // contextPressure is (promptTokens + margin) / window, and a token is four characters.
    const window = 32_768;
    const chars = Math.max(0, (fraction * window - BUDGET.contextMargin) * 4);
    return compose({ activeTools: ['get_logs'], toolRegistry: registry, historyChars: Math.round(chars), maxContextTokens: window });
  };

  it('spells out usage guidance while there is room', () => {
    expect(at(0.10)).toContain('- **get_logs**: Read logs. — Call it when something is broken.');
  });

  it('drops to one line per tool at 40%', () => {
    expect(at(0.42)).toContain('- `get_logs`: Read logs.');
    expect(at(0.42)).not.toContain('Call it when something is broken.');
  });

  it('adds the notice at 48%', () => {
    expect(at(0.42)).not.toContain('Context window is >48% full');
    expect(at(0.49)).toContain('[Notice: Context window is >48% full. Keep thoughts and answers concise.]');
  });

  it('is at its most compact from 50%', () => {
    expect(at(0.51)).toContain('- `get_logs`: Read logs.');
    expect(at(0.51)).toContain('Context window is >48% full');
  });

  it('heads the list the same way whatever the pressure', () => {
    for (const p of [0.10, 0.42, 0.51]) expect(at(p)).toContain('## Active Tools (each carries its own usage guidance — read it before calling)');
  });
});

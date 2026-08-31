import type { BudgetConfig, PersonaPack, PromptConfig, SamplingConfig, WorkspaceScope } from '@koala/harness-types';
import { KOALA_NAME } from './koala-persona.js';
import { MERGER_PERSONA } from './well-known-personas.js';
import { researchPacing } from './sandbox-tools.js';
import { WEB_TOOL_NAMES } from './leaf-tools.js';

const TUNED_FOR = 'Tabbyapi-Production';

const DEFAULT_SAMPLING: SamplingConfig = {
  toolTurn: { temperature: 0.3 },
  conversation: { frequency_penalty: 0.4, presence_penalty: 0.3 },
  byEngine: {
    tabbyapi: { dry_multiplier: 0.8, dry_base: 1.75, dry_allowed_length: 2 },
  },
};

const defaultSampling = (): SamplingConfig => structuredClone(DEFAULT_SAMPLING);

const DEFAULT_BUDGET: BudgetConfig = {
  replyTokens: { tool: 800, thinking: 2000, writingFiles: 8000, plan: 8000, ceiling: 16000 },
  contextTokens: 32_768,
  contextMargin: 512,
  minReplyTokens: 600,
  rounds: 8,
  proposalsPerReply: 8,
  toolResultChars: 8_000,
  conversationChars: 60_000,
  conversationGrowth: 2,
  messageChars: 6000,
  run: { steps: 200, tokens: 1_000_000, researchSteps: 100, wrapUpSteps: 4 },
  handoff: {
    at: 0.55, tail: 4, reasoningKept: 6, goalChars: 600,
    discoveryChars: 160, discoveries: 8, listedProposals: 10,
  },
  record: {
    callsPerRound: 6, argChars: 400, digestChars: 2000,
    traceReasoning: 6000, traceContent: 2000, traceToolResult: 1200, traceToolArgs: 2000,
  },
};

const defaultBudget = (): BudgetConfig => structuredClone(DEFAULT_BUDGET);

const DEFAULT_PROMPT: PromptConfig = {
  pressure: { compactAt: 0.40, minimalAt: 0.50, noticeAt: 0.48 },
  sections: {
    role: {
      admin:
        '## Platform Role: Administrator\n'
        + 'You are interacting with a cluster Administrator. You have cluster-wide visibility across all namespaces, '
        + 'including platform monitoring (Prometheus, Grafana, Alertmanager), logging (Loki), and git infrastructure (Gitea). '
        + 'You may inspect system services and diagnose cluster health directly.',
      escalated:
        '## Escalated Privileges: Active\n'
        + 'Elevated cluster access has been approved for this session. Scope includes system namespaces: {{namespaces}}. '
        + 'You may inspect diagnostics, logs, and events within these namespaces.',
      standard:
        '## Standard Tenant Boundaries\n'
        + 'You are operating with standard tenant privileges. If diagnosing an issue requires access to cluster system '
        + 'namespaces (e.g. monitoring, gitea, kube-system), call request_escalated_privileges with a clear, honest reason.',
    },
    secrets:
      '## Secrets & Configuration Runtime Model\n'
      + '- Applications run in Kubernetes containers where all secrets and configuration are injected as standard environment variables.\n'
      + '- When authoring or scaffolding application code, ALWAYS write code that reads from environment variables (e.g. process.env.<KEY> in Node.js, os.environ["<KEY>"] in Python). Do NOT write code that calls external vault APIs directly from inside the app.\n'
      + '- When an application requires a sensitive token, password, or API key from the user, NEVER ask them to paste it in plaintext chat. Always call request_secret to display a secure UI card.\n'
      + '- Once the user vaults the secret in Infisical, call inject_secret_to_pod to update the pod\'s Kubernetes Secret (<app>-secrets) and trigger a rolling restart.',
    toolGuidance: '## Active Tools (each carries its own usage guidance — read it before calling)',
    services: {
      none: 'No services are deployed yet. Propose a project to build one.',
      heading: '## Services You Can Hook Up (via enable_mcp_server)',
    },
    memories:
      '## Recalled Platform & Project Memories\n'
      + 'Relevant lessons learned, environment facts, and proven patterns recalled from previous runs:',
    pressureNotice: '[Notice: Context window is >{{percent}}% full. Keep thoughts and answers concise.]',
    toolDiscipline: [
      'Never invent, predict, or write out a tool result. If you need data, call the tool and stop —',
      'the result will be given to you in the next turn. Do not deliberate about output formatting;',
      'call the tool directly.',
    ].join('\n'),
  },
};

const defaultPrompt = (): PromptConfig => structuredClone(DEFAULT_PROMPT);

export interface PackSeed {
  slug: string;
  name: string;
  description: string;
  personaName: string;
  tools: string[];
  mcp?: string[];
  workspace?: WorkspaceScope;
  sampling: SamplingConfig;
  budget: BudgetConfig;
  prompt: PromptConfig;
}

export const PACK_SEEDS: PackSeed[] = [
  {
    slug: 'koala',
    name: KOALA_NAME,
    description: 'General chat. Talks things through, operates projects, and proposes new builds.',
    personaName: KOALA_NAME,
    tools: [
      'propose_tree', 'list_tree_types', 'propose_spec', 'add_project_dependency', 'list_trees',
      'get_project_pipeline', 'get_project_env', 'set_project_env', 'deploy_project', 'get_project_url',
      'get_logs', 'get_events', 'inspect_resources', 'cluster_capacity', 'list_infrastructure',
      'list_mcp_servers', 'enable_mcp_server',
      'request_escalated_privileges', 'request_secret', 'inject_secret_to_pod',
      'get_project_secret', 'set_project_secret', 'list_project_secrets',
      'web_search', 'fetch_web_page',
    ],
    sampling: defaultSampling(),
    budget: defaultBudget(),
    prompt: defaultPrompt(),
  },
  {
    slug: 'framer',
    name: 'Framer',
    description: 'Breaks a large question into small ones that can each be answered on their own.',
    personaName: 'Framer',
    tools: ['read_file', 'write_file', 'finish'],
    workspace: {
      egress: [], repo: false, language: 'base',
      output: '/work/questions.md', requireSources: false,
      tunedFor: TUNED_FOR,
      run: { maxSteps: 20 },
    },
    sampling: { ...defaultSampling(), toolTurn: { ...defaultSampling().toolTurn, temperature: 0.3 } },
    budget: defaultBudget(),
    prompt: defaultPrompt(),
  },
  {
    slug: 'researcher',
    name: 'Researcher',
    description: 'Answers one narrow question from sources, and cites them.',
    personaName: 'Researcher',
    tools: ['web_search', 'fetch_web_page', 'read_file', 'write_file', 'finish'],
    workspace: {
      repo: false, language: 'base', output: '/work/findings.md', egress: [],
      tunedFor: TUNED_FOR,
      run: {
        maxSteps: DEFAULT_BUDGET.run.researchSteps,
        withdraw: { afterStep: Math.floor(DEFAULT_BUDGET.run.researchSteps / 2), tools: [...WEB_TOOL_NAMES] },
        pacing: researchPacing(DEFAULT_BUDGET.run.researchSteps, '/work/findings.md', DEFAULT_BUDGET.run.wrapUpSteps),
      },
    },
    sampling: { ...defaultSampling(), toolTurn: { ...defaultSampling().toolTurn, temperature: 0.4 } },
    budget: defaultBudget(),
    prompt: defaultPrompt(),
  },
  {
    slug: 'synthesist',
    name: 'Synthesist',
    description: 'Turns a pile of separate answers into one piece of writing.',
    personaName: 'Synthesist',
    tools: ['read_file', 'write_file', 'finish'],
    workspace: {
      repo: false, language: 'base', output: '/work/findings.md',
      requireSources: false, egress: [],
      tunedFor: TUNED_FOR,
      run: { maxSteps: 30 },
    },
    sampling: { ...defaultSampling(), toolTurn: { ...defaultSampling().toolTurn, temperature: 0.5 } },
    budget: defaultBudget(),
    prompt: defaultPrompt(),
  },
  {
    slug: 'merger',
    name: MERGER_PERSONA,
    description: 'Resolves merge conflicts when leaves land on the default branch.',
    personaName: MERGER_PERSONA,
    tools: ['run_command', 'read_file', 'write_file', 'finish'],
    workspace: {
      repo: true, egress: [{ namespace: 'gitea', ports: [3000] }],
      tunedFor: TUNED_FOR, run: { maxSteps: 30 },
    },
    sampling: { ...defaultSampling(), toolTurn: { ...defaultSampling().toolTurn, temperature: 0.2 } },
    budget: defaultBudget(),
    prompt: defaultPrompt(),
  },
  {
    slug: 'ingestor',
    name: 'Ingestor',
    description: 'Crawls sites into the corpus, and answers from it.',
    personaName: 'Ingestor',
    tools: ['start_ingest', 'ingest_status', 'search_corpus', 'read_file', 'write_file', 'finish'],
    workspace: {
      repo: false, language: 'base', output: '/work/findings.md', egress: [],
      tunedFor: TUNED_FOR, run: { maxSteps: 40 },
    },
    sampling: { ...defaultSampling(), toolTurn: { ...defaultSampling().toolTurn, temperature: 0.3 } },
    budget: defaultBudget(),
    prompt: defaultPrompt(),
  },
  {
    slug: 'reviewer',
    name: 'Reviewer',
    description: 'Reads a failed leaf and says why it failed.',
    personaName: 'Reviewer',
    tools: [],
    workspace: { repo: false, language: 'base' },
    sampling: defaultSampling(),
    budget: defaultBudget(),
    prompt: defaultPrompt(),
  },
  {
    slug: 'judge',
    name: 'Judge',
    description: 'Reads what a leaf produced and says whether the claim holds up.',
    personaName: 'Judge',
    tools: [],
    workspace: { repo: false, language: 'base' },
    sampling: { ...defaultSampling(), toolTurn: { ...defaultSampling().toolTurn, temperature: 0.1 } },
    budget: defaultBudget(),
    prompt: defaultPrompt(),
  },
  {
    slug: 'builder',
    name: 'Builder',
    description: 'Writes code in a repository, with tests, and commits it.',
    personaName: 'Builder',
    tools: ['run_command', 'read_file', 'write_file', 'finish'],
    workspace: {
      repo: true,
      egress: [{ namespace: 'gitea', ports: [3000] }],
      tunedFor: TUNED_FOR,
    },
    sampling: defaultSampling(),
    budget: defaultBudget(),
    prompt: defaultPrompt(),
  },
];

export const builtInPackId = (slug: string) => `builtin-pack-${slug}`;

export interface PackSeedStore {
  getPersonaPacks(): Promise<PersonaPack[]>;
  savePersonaPack(pack: PersonaPack): Promise<void>;
  deletePersonaPack(id: string): Promise<void>;
  getPersonas(): Promise<{ id: string; ownerId?: string | undefined; name: string }[]>;
}

export async function seedPacks(store: PackSeedStore): Promise<number> {
  const stored = await store.getPersonaPacks();
  for (const p of stored) {
    if (p.ownerId == null) await store.deletePersonaPack(p.id);
  }

  const personas = (await store.getPersonas()).filter((p) => p.ownerId == null);
  const personaByName = new Map(personas.map((p) => [p.name, p]));

  const now = new Date().toISOString();
  for (const seed of PACK_SEEDS) {
    const persona = personaByName.get(seed.personaName);
    if (!persona) continue;

    const next: PersonaPack = {
      id: builtInPackId(seed.slug),
      slug: seed.slug,
      name: seed.name,
      description: seed.description,
      personaId: persona.id,
      tools: [...seed.tools],
      ...(seed.mcp ? { mcp: [...seed.mcp] } : {}),
      ...(seed.workspace ? { workspace: seed.workspace } : {}),
      sampling: structuredClone(seed.sampling),
      budget: structuredClone(seed.budget),
      prompt: structuredClone(seed.prompt),
      builtIn: true,
      createdAt: now,
      updatedAt: now,
    };
    await store.savePersonaPack(next);
  }
  // Count only packs that were actually written (persona was found).
  const all = await store.getPersonaPacks();
  return all.filter((p) => p.ownerId == null).length;
}

export function packForLeaf(
  packs: readonly PersonaPack[],
  leaf: { packId?: string | undefined },
  fallbackPackId?: string | undefined,
): PersonaPack | undefined {
  const wanted = leaf.packId ?? fallbackPackId;
  if (!wanted) return undefined;
  return packs.find((p) => p.id === wanted || p.slug === wanted);
}
import type { BudgetConfig, PersonaPack, PromptConfig, SamplingConfig } from '@koala/harness-types';
import { KOALA_NAME } from './koala-persona.js';
import { researchPacing } from './sandbox-tools.js';
import { WEB_TOOL_NAMES } from './leaf-tools.js';
import { sameSeededRow } from './seed-diff.js';
import { EXTRACTION_SYSTEM_PROMPT } from './extraction.js';

const TUNED_FOR = 'Tabbyapi-Production';

const DEFAULT_SAMPLING: SamplingConfig = {
  toolTurn: { temperature: 0.3 },
  /**
   * Verified live against Tabbyapi-Production (turboderp/Qwen3.8-27B-exl3): 0.4/0.3 reliably drove
   * a long "thinking" turn into multilingual word-salad — the penalty compounds across a long
   * reasoning trace until the sampler is forced off-distribution. Reproduced with a raw request
   * replayed straight at the model (bypassing this app entirely), isolated to these two fields
   * alone, and confirmed fixed at these values with the same replayed request. Not proven safe for
   * every model this pack could run on — a value this sensitive to a specific engine's behavior is
   * exactly what `byEngine` exists for, but this default has to be non-catastrophic everywhere
   * since most packs never set an override.
   */
  conversation: { frequency_penalty: 0.1, presence_penalty: 0.1 },
  byEngine: {
    tabbyapi: { dry_multiplier: 0 },
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

const PLANNING_CONTRACT = [
  'When — and only when — you are confident about concrete work that should be done, propose it by',
  'calling propose_leaf once per separately deliverable piece. Do not describe the plan in your reply',
  'text instead of calling the tool — a plan that exists only as prose was never actually proposed,',
  'and nothing downstream ever reads your reply text for it.',
  '',
  'Rules:',
  '- `persona` is REQUIRED on every propose_leaf call. Use a name from the personas listed for you,',
  '  exactly as written. A persona decides the toolchain, what the work may reach, and how long it',
  '  may run — a leaf with no persona, or with a name that is not real, cannot be started by anyone.',
  '- Before proposing work that needs a capability, call list_mcp_servers to see what is already',
  '  running. Servers deployed here are real and their tools are callable from a leaf, so prefer',
  '  using one over rebuilding it. When the work BUILDS a server, propose a final leaf that calls',
  '  its tools for real — a server nothing has ever called is not known to work.',
  '- Call set_acceptance once, for the request as a whole. Per-leaf checks prove each piece; only',
  '  this proves the finished thing works. For a service, that means RUNNING it and calling it for',
  '  real, not just running the test suite.',
  '  Write the checks as a SEQUENCE: install dependencies, then build or test, then run the thing.',
  '  A check that runs the product without installing it first fails on a missing package and',
  '  proves nothing about the product.',
  '- End the plan with a leaf that exercises the FINISHED thing the way a user would: call the',
  '  deployed service, run the entry point, open the artefact. Name what it must produce in',
  '  `expects`, so its success is a file that exists rather than a claim.',
  '- When this project depends on a service (anything you declared with add_project_dependency), a',
  '  sandbox CANNOT verify the connection — bindings exist only in the deployed service. That final',
  '  leaf must call the DEPLOYED thing instead: name the service in its `mcp` so it can call its',
  '  tools for real, and check the response is what a user would get.',
  '  Do the same whenever the assembled result could fail in ways the individual pieces cannot.',
  '- Record the plan with write_plan_document before you finish. It is committed to the project',
  '  repository, so every leaf that clones it can read the shape of the whole.',
  '- Propose nothing if the work is still unclear. Ask a question instead.',
  '- One leaf per genuinely separate piece of work. Do not split a single change into steps.',
  '- Never propose the same work twice under different wording. Naming the file in one title and',
  '  the action in another still describes one leaf.',
  '- Titles are imperative and specific: "Add a rate limit to /api/chat", not "Rate limiting".',
  '- Anything you propose is only a suggestion; a human accepts it before it runs.',
].join('\n');

const AMBIENT_PLANNING_CONTRACT = [
  'If you become confident about concrete work that should be done, you may end your reply with:',
  '```json',
  '{"leaves":[{"title":"Imperative title","body":"What it involves","persona":"Persona name"}]}',
  '```',
  'Only when the work is clear. Otherwise just talk, or ask a question.',
].join('\n');

const ASSIGNMENT_NUDGE = [
  'A leaf needs a persona assigned before it can run — the toolchain, network access and time',
  'budget it gets all come from the tree type once accepted, but nothing starts until someone is named.',
].join('\n');

/**
 * Extracting proposals from prose and nudging an unassigned leaf are turn-level mechanics that run
 * for any chat pack, koala included — not specific to the planner role's propose_leaf tool contract.
 */
const chatMechanicsPrompt = (): PromptConfig => ({
  ...structuredClone(DEFAULT_PROMPT),
  sections: {
    ...structuredClone(DEFAULT_PROMPT.sections),
    extraction: EXTRACTION_SYSTEM_PROMPT,
    assignmentNudge: ASSIGNMENT_NUDGE,
  },
});

const plannerPrompt = (): PromptConfig => ({
  ...chatMechanicsPrompt(),
  sections: {
    ...chatMechanicsPrompt().sections,
    planning: PLANNING_CONTRACT,
    ambientPlanning: AMBIENT_PLANNING_CONTRACT,
  },
});

export interface PackSeed {
  slug: string;
  name: string;
  description: string;
  personaName: string;
  tools: string[];
  mcp?: string[];
  /** Does sandboxed work (a leaf can be assigned to it) — false/omitted for chat-only roles (koala, planner). */
  canRunLeaf?: boolean;
  output?: string;
  tunedFor?: string;
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
    prompt: chatMechanicsPrompt(),
  },
  {
    slug: 'planner',
    name: 'Planner',
    description: 'Turns a proposed project goal into a concrete plan of executable leaves.',
    personaName: 'Planner',
    tools: [
      'list_leaves', 'get_leaf', 'propose_leaf', 'revise_leaf', 'withdraw_leaf', 'replace_leaf',
      'set_acceptance', 'list_personas', 'list_mcp_servers', 'list_tree_types',
      'list_projects', 'create_project', 'set_leaf_project', 'add_project_dependency',
      'write_plan_document', 'research',
    ],
    sampling: { ...defaultSampling(), toolTurn: { ...defaultSampling().toolTurn, temperature: 0.3 } },
    budget: defaultBudget(),
    prompt: plannerPrompt(),
  },
  {
    slug: 'researcher',
    name: 'Researcher',
    description: 'Answers one narrow question from sources, and cites them.',
    personaName: 'Researcher',
    tools: ['web_search', 'fetch_web_page', 'read_file', 'write_file', 'finish'],
    canRunLeaf: true,
    output: '/work/findings.md',
    tunedFor: TUNED_FOR,
    sampling: { ...defaultSampling(), toolTurn: { ...defaultSampling().toolTurn, temperature: 0.4 } },
    budget: {
      ...defaultBudget(),
      run: {
        ...defaultBudget().run,
        steps: DEFAULT_BUDGET.run.researchSteps,
        withdraw: { afterStep: Math.floor(DEFAULT_BUDGET.run.researchSteps / 2), tools: [...WEB_TOOL_NAMES] },
        pacing: researchPacing(DEFAULT_BUDGET.run.researchSteps, '/work/findings.md', DEFAULT_BUDGET.run.wrapUpSteps),
      },
    },
    prompt: defaultPrompt(),
  },
  {
    slug: 'synthesist',
    name: 'Synthesist',
    description: 'Turns a pile of separate answers into one piece of writing.',
    personaName: 'Synthesist',
    tools: ['read_file', 'write_file', 'finish'],
    canRunLeaf: true,
    output: '/work/findings.md',
    tunedFor: TUNED_FOR,
    sampling: { ...defaultSampling(), toolTurn: { ...defaultSampling().toolTurn, temperature: 0.5 } },
    budget: { ...defaultBudget(), run: { ...defaultBudget().run, steps: 30 } },
    prompt: defaultPrompt(),
  },
  {
    slug: 'merger',
    name: 'Merger',
    description: 'Resolves merge conflicts when leaves land on the default branch.',
    personaName: 'Merger',
    tools: ['run_command', 'read_file', 'write_file', 'finish'],
    canRunLeaf: true,
    tunedFor: TUNED_FOR,
    sampling: { ...defaultSampling(), toolTurn: { ...defaultSampling().toolTurn, temperature: 0.2 } },
    budget: { ...defaultBudget(), run: { ...defaultBudget().run, steps: 30 } },
    prompt: defaultPrompt(),
  },
  {
    slug: 'ingestor',
    name: 'Ingestor',
    description: 'Crawls sites into the corpus, and answers from it.',
    personaName: 'Ingestor',
    tools: ['start_ingest', 'ingest_status', 'search_corpus', 'read_file', 'write_file', 'finish'],
    canRunLeaf: true,
    output: '/work/findings.md',
    tunedFor: TUNED_FOR,
    sampling: { ...defaultSampling(), toolTurn: { ...defaultSampling().toolTurn, temperature: 0.3 } },
    budget: { ...defaultBudget(), run: { ...defaultBudget().run, steps: 40 } },
    prompt: defaultPrompt(),
  },
  {
    slug: 'reviewer',
    name: 'Reviewer',
    description: 'Reads a failed leaf and says why it failed.',
    personaName: 'Reviewer',
    tools: [],
    canRunLeaf: true,
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
    canRunLeaf: true,
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
    canRunLeaf: true,
    tunedFor: TUNED_FOR,
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
  const builtIns = new Map(stored.filter((p) => p.ownerId == null).map((p) => [p.id, p]));

  const personas = (await store.getPersonas()).filter((p) => p.ownerId == null);
  const personaByName = new Map(personas.map((p) => [p.name, p]));

  const now = new Date().toISOString();
  const seeded = new Set<string>();
  let written = 0;

  for (const seed of PACK_SEEDS) {
    const persona = personaByName.get(seed.personaName);
    if (!persona) continue;

    const id = builtInPackId(seed.slug);
    seeded.add(id);
    const existing = builtIns.get(id);

    const next: PersonaPack = {
      id,
      slug: seed.slug,
      name: seed.name,
      description: seed.description,
      personaId: persona.id,
      tools: [...seed.tools],
      ...(seed.mcp ? { mcp: [...seed.mcp] } : {}),
      ...(seed.canRunLeaf ? { canRunLeaf: seed.canRunLeaf } : {}),
      ...(seed.output ? { output: seed.output } : {}),
      ...(seed.tunedFor ? { tunedFor: seed.tunedFor } : {}),
      sampling: structuredClone(seed.sampling),
      budget: structuredClone(seed.budget),
      prompt: structuredClone(seed.prompt),
      builtIn: true,
      createdAt: existing?.createdAt ?? now,
      updatedAt: existing?.updatedAt ?? now,
    };

    if (existing && sameSeededRow(existing, next)) continue;
    await store.savePersonaPack({ ...next, updatedAt: now });
    written++;
  }

  for (const id of builtIns.keys()) {
    if (seeded.has(id)) continue;
    await store.deletePersonaPack(id);
    written++;
  }

  return written;
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
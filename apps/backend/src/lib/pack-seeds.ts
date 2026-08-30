import type { BudgetConfig, PersonaPack, SamplingConfig, WorkspaceScope } from '@koala/harness-types';
import { KOALA_NAME } from './koala-persona.js';
import { MERGER_PERSONA } from './well-known-personas.js';
import { researchPacing } from './sandbox-tools.js';
import { WEB_TOOL_NAMES } from './leaf-tools.js';

const TUNED_FOR = 'Tabbyapi-Production';

/**
 * What every pack sampled at when this was a module constant. Stated here so a pack carries its own
 * values and can be edited; shared by reference nowhere — each seed gets its own copy, so changing
 * one pack cannot retune the rest.
 *
 * temperature 0.3 on a dispatch turn, penalties on a conversation turn, and TabbyAPI's DRY guards
 * layered on top when that is the engine.
 */
const DEFAULT_SAMPLING: SamplingConfig = {
  toolTurn: { temperature: 0.3 },
  conversation: { frequency_penalty: 0.4, presence_penalty: 0.3 },
  byEngine: {
    tabbyapi: { dry_multiplier: 0.8, dry_base: 1.75, dry_allowed_length: 2 },
  },
};

const defaultSampling = (): SamplingConfig => structuredClone(DEFAULT_SAMPLING);

/**
 * What every pack spent when these were module constants, in the three files that owned them.
 * Same rule as the sampler: each seed gets its own copy, so retuning one pack cannot retune nine.
 *
 * `rounds` is 8, which is what `MAX_TOOL_ROUNDS` was and what the harness config panel has always
 * advertised as "Tool rounds per turn". The unified chat route ran 12 from an unnamed default
 * parameter — one concept with two values, and this is the one that was written down.
 */
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
    at: 0.55,
    tail: 4,
    reasoningKept: 6,
    goalChars: 600,
    discoveryChars: 160,
    discoveries: 8,
    listedProposals: 10,
  },
  record: {
    callsPerRound: 6,
    argChars: 400,
    digestChars: 2000,
    traceReasoning: 6000,
    traceContent: 2000,
    traceToolResult: 1200,
    traceToolArgs: 2000,
  },
};

const defaultBudget = (): BudgetConfig => structuredClone(DEFAULT_BUDGET);

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
  overrides: PersonaPack['overrides'];
}

export const PACK_SEEDS: PackSeed[] = [
  {
    slug: 'koala',
    name: KOALA_NAME,
    description: 'General chat. Talks things through, operates projects, and proposes new builds.',
    personaName: KOALA_NAME,
    tools: [
      'propose_tree', 'propose_spec', 'add_project_dependency', 'list_trees',
      'get_project_pipeline', 'get_project_env', 'set_project_env', 'deploy_project', 'get_project_url',
      'get_logs', 'get_events', 'inspect_resources', 'cluster_capacity', 'list_infrastructure',
      'list_mcp_servers', 'enable_mcp_server',
      'request_escalated_privileges', 'request_secret', 'inject_secret_to_pod',
      'get_project_secret', 'set_project_secret', 'list_project_secrets',
      'web_search', 'fetch_web_page',
    ],
    sampling: defaultSampling(),
    budget: defaultBudget(),
    overrides: {},
  },
  {
    slug: 'framer',
    name: 'Framer',
    description: 'Breaks a large question into small ones that can each be answered on their own.',
    personaName: 'Framer',
    tools: ['read_file', 'write_file', 'finish'],
    workspace: {
    egress: [],
    repo: false,
    language: 'base',
    output: '/work/questions.md',
    requireSources: false,
    tunedFor: TUNED_FOR,
    run: { maxSteps: 20 },
    },
    sampling: defaultSampling(),
    budget: defaultBudget(),
    overrides: { temperature: 0.3 },
  },
  {
    slug: 'researcher',
    name: 'Researcher',
    description: 'Answers one narrow question from sources, and cites them.',
    personaName: 'Researcher',
    tools: ['web_search', 'fetch_web_page', 'read_file', 'write_file', 'finish'],
    workspace: {
    repo: false,
    language: 'base',
    output: '/work/findings.md',
    egress: [],
    tunedFor: TUNED_FOR,
    run: {
    maxSteps: DEFAULT_BUDGET.run.researchSteps,
    withdraw: { afterStep: Math.floor(DEFAULT_BUDGET.run.researchSteps / 2), tools: [...WEB_TOOL_NAMES] },
    pacing: researchPacing(DEFAULT_BUDGET.run.researchSteps, '/work/findings.md', DEFAULT_BUDGET.run.wrapUpSteps),
    },
    },
    sampling: defaultSampling(),
    budget: defaultBudget(),
    overrides: { temperature: 0.4 },
  },
  {
    slug: 'synthesist',
    name: 'Synthesist',
    description: 'Turns a pile of separate answers into one piece of writing.',
    personaName: 'Synthesist',
    tools: ['read_file', 'write_file', 'finish'],
    workspace: {
    repo: false,
    language: 'base',
    output: '/work/findings.md',
    requireSources: false,
    egress: [],
    tunedFor: TUNED_FOR,
    run: { maxSteps: 30 },
    },
    sampling: defaultSampling(),
    budget: defaultBudget(),
    overrides: { temperature: 0.5 },
  },
  {
    slug: 'merger',
    name: MERGER_PERSONA,
    description: 'Resolves merge conflicts when leaves land on the default branch.',
    personaName: MERGER_PERSONA,
    tools: ['run_command', 'read_file', 'write_file', 'finish'],
    workspace: {
    repo: true,
    egress: [{ namespace: 'gitea', ports: [3000] }],
    tunedFor: TUNED_FOR,
    run: { maxSteps: 30 },
    },
    sampling: defaultSampling(),
    budget: defaultBudget(),
    overrides: { temperature: 0.2 },
  },
  {
    slug: 'ingestor',
    name: 'Ingestor',
    description: 'Crawls sites into the corpus, and answers from it.',
    personaName: 'Ingestor',
    tools: ['start_ingest', 'ingest_status', 'search_corpus', 'read_file', 'write_file', 'finish'],
    workspace: {
    repo: false,
    language: 'base',
    output: '/work/findings.md',
    egress: [],
    tunedFor: TUNED_FOR,
    run: { maxSteps: 40 },
    },
    sampling: defaultSampling(),
    budget: defaultBudget(),
    overrides: { temperature: 0.3 },
  },
  {
    slug: 'reviewer',
    name: 'Reviewer',
    description: 'Reads a failed leaf and says why it failed.',
    personaName: 'Reviewer',
    tools: [],
    workspace: {
    repo: false,
    language: 'base',
    },
    sampling: defaultSampling(),
    budget: defaultBudget(),
    overrides: {},
  },
  {
    slug: 'judge',
    name: 'Judge',
    description: 'Reads what a leaf produced and says whether the claim holds up.',
    personaName: 'Judge',
    tools: [],
    workspace: {
    repo: false,
    language: 'base',
    },
    sampling: defaultSampling(),
    budget: defaultBudget(),
    overrides: { temperature: 0.1 },
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
    overrides: {},
  },
];

export const builtInPackId = (slug: string) => `builtin-pack-${slug}`;

export interface PackSeedStore {
  getPersonaPacks(): Promise<PersonaPack[]>;
  savePersonaPack(pack: PersonaPack): Promise<void>;
  getPersonas(): Promise<{ id: string; ownerId?: string | undefined; name: string }[]>;
}

export async function seedPacks(store: PackSeedStore): Promise<number> {
  const stored = await store.getPersonaPacks();
  const builtIns = new Map(stored.filter((p) => p.ownerId === undefined).map((p) => [p.slug, p]));
  const personas = (await store.getPersonas()).filter((p) => p.ownerId === undefined);

  let written = 0;
  for (const seed of PACK_SEEDS) {
    const persona = personas.find((p) => p.name === seed.personaName);
    if (!persona) continue;

    const prior = builtIns.get(seed.slug);
    const next: PersonaPack = {
      id: prior?.id ?? builtInPackId(seed.slug),
      slug: seed.slug,
      name: seed.name,
      description: seed.description,
      personaId: persona.id,
      tools: [...seed.tools],
      ...(seed.mcp ? { mcp: [...seed.mcp] } : {}),
      ...(seed.workspace ? { workspace: seed.workspace } : {}),
      sampling: structuredClone(seed.sampling),
      budget: structuredClone(seed.budget),
      overrides: { ...seed.overrides },
      builtIn: true,
      createdAt: prior?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    if (prior && JSON.stringify({ ...prior, updatedAt: '' }) === JSON.stringify({ ...next, updatedAt: '' })) continue;
    await store.savePersonaPack(next);
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

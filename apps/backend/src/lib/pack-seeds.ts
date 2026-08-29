import type { PersonaPack, WorkspaceScope } from '@koala/harness-types';
import { KOALA_NAME } from './koala-persona.js';
import { MERGER_PERSONA } from './well-known-personas.js';
import { RESEARCH_AGENT_STEPS, researchPacing } from './sandbox-tools.js';
import { WEB_TOOL_NAMES } from './leaf-tools.js';

const TUNED_FOR = 'Tabbyapi-Production';

export interface PackSeed {
  slug: string;
  name: string;
  description: string;
  personaName: string;
  tools: string[];
  mcp?: string[];
  workspace?: WorkspaceScope;
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
    maxSteps: RESEARCH_AGENT_STEPS,
    withdraw: { afterStep: Math.floor(RESEARCH_AGENT_STEPS / 2), tools: [...WEB_TOOL_NAMES] },
    pacing: researchPacing(RESEARCH_AGENT_STEPS, '/work/findings.md'),
    },
    },
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

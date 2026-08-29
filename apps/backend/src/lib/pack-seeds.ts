import type { PersonaPack, PersonaScope, ToolEffect } from '@koala/harness-types';
import { KOALA_NAME } from './koala-persona.js';
import { PERSONA_SEEDS } from './persona-seeds.js';

export interface PackSeed {
  slug: string;
  name: string;
  description: string;
  personaName: string;
  toolset: PersonaPack['toolset'];
  tools: string[];
  permitted: ToolEffect[];
  overrides: PersonaPack['overrides'];
}

const KOALA_TOOLS_GRANTED = [
  'propose_tree', 'propose_spec', 'add_project_dependency', 'list_trees',
  'get_project_pipeline', 'get_project_env', 'set_project_env', 'deploy_project', 'get_project_url',
  'get_logs', 'get_events', 'inspect_resources', 'cluster_capacity', 'list_infrastructure',
  'list_mcp_servers', 'enable_mcp_server',
  'request_escalated_privileges', 'request_secret', 'inject_secret_to_pod',
  'get_project_secret', 'set_project_secret', 'list_project_secrets',
  'web_search', 'fetch_web_page',
];

const WORK_PACKS: PackSeed[] = PERSONA_SEEDS
  .filter((p) => p.name !== KOALA_NAME)
  .map((p) => ({
    slug: p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    name: p.name,
    description: p.description ?? '',
    personaName: p.name,
    toolset: 'sandbox' as const,
    tools: [...(p.scope?.tools ?? [])],
    permitted: ['read', 'write', 'propose'] as ToolEffect[],
    overrides: { ...(p.overrides ?? {}) },
  }));

export const PACK_SEEDS: PackSeed[] = [
  {
    slug: 'koala',
    name: 'Koala',
    description: 'General chat. Talks things through, operates projects, and proposes new builds.',
    personaName: KOALA_NAME,
    toolset: 'assistant',
    tools: KOALA_TOOLS_GRANTED,
    permitted: ['read', 'write', 'propose'],
    overrides: { temperature: 0.7 },
  },
  ...WORK_PACKS,
];

export interface PackSeedStore {
  getPersonaPacks(): Promise<PersonaPack[]>;
  savePersonaPack(pack: PersonaPack): Promise<void>;
  getPersonas(): Promise<{ id: string; ownerId?: string | undefined; name: string; scope?: PersonaScope }[]>;
}

export const builtInPackId = (slug: string) => `builtin-pack-${slug}`;

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
      toolset: seed.toolset,
      tools: [...seed.tools],
      permitted: [...seed.permitted],
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

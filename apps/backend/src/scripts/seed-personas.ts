/**
 * The personas that own an environment, not just a prompt.
 *
 * ── WHY THESE ARE SEEDED ──
 * Every leaf runs as somebody. When the planner does not name a persona, the fallback has to be a
 * real record with a real environment — so a `defaultFor` must exist for each context or work lands
 * in whatever the calling activity happens to hardcode, which is the coupling the persona record
 * exists to remove.
 *
 * ── WHY THE TOOLSETS ARE EXPLICIT ──
 * The Framer's whole job is turning one big question into several. Attached to a research leaf,
 * which grants web tools by kind, it spent its entire budget searching and produced nothing: 500
 * seconds, measured. It is not told to avoid searching here — it is not given a search tool, and it
 * is given no network at all. That is a fact about the run rather than a request.
 *
 * Idempotent: matched by name and updated in place, so running it twice does not produce two
 * Researchers competing to be the default.
 *
 * Run with: npx tsx src/scripts/seed-personas.ts
 */
import { MongoDB } from '../lib/mongo-db.js';
import { v4 as uuidv4 } from 'uuid';
import type { Persona } from '@koala/harness-types';
import { MERGER_PERSONA } from '../lib/well-known-personas.js';
import { RESEARCH_AGENT_STEPS, researchPacing } from '../lib/sandbox-tools.js';
import { WEB_TOOL_NAMES } from '../lib/leaf-tools.js';
import { PERSONA_SEEDS, RETIRED_PERSONAS } from '../lib/persona-seeds.js';

const OWNER = '2d5fe7e1-e7fc-4e88-8faf-8f08ba8b8991';

/** The model these prompts were actually written and checked against. Advisory — see PersonaScope. */



/**
 * Personas that predate the environment fields, and what they were doing before them.
 *
 * ── WHY THIS MIGRATION EXISTS ──
 * `repo` used to default to yes, so these four got a checkout without ever asking for one. The
 * default is now no — a repository is something a persona requests, because most work is not a
 * codebase and defaulting the other way is what produced 27 projects of which 26 never built.
 *
 * Flipping that default silently would have taken the repository away from four personas that were
 * relying on it, which loses the work: a sandbox is destroyed when its leaf ends, so a builder that
 * cannot push has nothing left. They are named here and given explicitly what they had implicitly.
 */

async function main() {
  const mongo = new MongoDB();
  await mongo.init();
  const existing = (await mongo.getPersonas()).filter((p) => p.ownerId === OWNER);
  const now = new Date().toISOString();

  /**
   * Retired, not left to rot.
   *
   * A persona nobody deletes is one the planner can still pick, and these describe an environment
   * that no longer exists. Leaves already assigned one keep their record — the id stays valid on
   * finished work — but nothing new can be handed to them.
   */
  for (const stale of existing.filter((p) => RETIRED_PERSONAS.includes(p.name))) {
    await mongo.deletePersona(stale.id);
    console.log(`retired   ${stale.name}`);
  }

  for (const seed of PERSONA_SEEDS) {
    const prior = existing.find((p) => p.name === seed.name);
    const persona: Persona = {
      id: prior?.id ?? uuidv4(),
      ownerId: OWNER,
      ...seed,
      createdAt: prior?.createdAt ?? now,
      updatedAt: now,
    };
    await mongo.savePersona(persona);
    console.log(`${prior ? 'updated' : 'created'}  ${persona.name.padEnd(12)} tools=${persona.scope?.tools?.join(',') ?? '(all)'}`);
  }

  // Also sync the Koala persona
  const { koalaSeed, KOALA_NAME } = await import('../lib/koala-persona.js');
  const priorKoala = existing.find((p) => p.name === KOALA_NAME);
  const koala: Persona = {
    id: priorKoala?.id ?? uuidv4(),
    ownerId: OWNER,
    ...koalaSeed(),
    createdAt: priorKoala?.createdAt ?? now,
    updatedAt: now,
  } as Persona;
  await mongo.savePersona(koala);
  console.log(`${priorKoala ? 'updated' : 'created'}  ${koala.name.padEnd(12)} (chat-only)`);

  process.exit(0);
}

main();

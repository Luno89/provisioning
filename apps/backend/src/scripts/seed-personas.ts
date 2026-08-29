import { MongoDB } from '../lib/mongo-db.js';
import { v4 as uuidv4 } from 'uuid';
import type { Persona } from '@koala/harness-types';
import { MERGER_PERSONA } from '../lib/well-known-personas.js';
import { RESEARCH_AGENT_STEPS, researchPacing } from '../lib/sandbox-tools.js';
import { WEB_TOOL_NAMES } from '../lib/leaf-tools.js';
import { PERSONA_SEEDS, RETIRED_PERSONAS } from '../lib/persona-seeds.js';

const OWNER = '2d5fe7e1-e7fc-4e88-8faf-8f08ba8b8991';

async function main() {
  const mongo = new MongoDB();
  await mongo.init();
  const existing = (await mongo.getPersonas()).filter((p) => p.ownerId === OWNER);
  const now = new Date().toISOString();

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

  process.exit(0);
}

main();

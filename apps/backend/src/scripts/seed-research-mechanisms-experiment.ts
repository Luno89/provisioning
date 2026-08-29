import { MongoDB } from '../lib/mongo-db.js';
import { v4 as uuidv4 } from 'uuid';
import type { Experiment } from '@koala/harness-types';

const OWNER = '2d5fe7e1-e7fc-4e88-8faf-8f08ba8b8991';
const NAME = 'Research mechanisms';

async function main() {
  const mongo = new MongoDB();
  await mongo.init();

  for (const item of (await mongo.getExperiments()).filter((e) => e.name === NAME)) {
    await mongo.deleteExperiment(item.id);
  }

  const personas = (await mongo.getPersonas()).filter((p) => p.ownerId === OWNER);
  const researcher = personas.find((p) => p.name === 'Researcher');
  if (!researcher) throw new Error('No "Researcher" persona for this owner — run seed-personas first.');

  const derive = async (name: string, description: string, scope: Record<string, unknown>) => {
    const prior = personas.find((p) => p.name === name);
    const persona = {
      id: prior?.id ?? uuidv4(),
      ownerId: OWNER,
      name,
      description,
      basedOn: researcher.id,
      overrides: {},
      scope,
      createdAt: prior?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as any;
    await mongo.savePersona(persona);
    return persona;
  };

  const shortBudget = await derive(
    'Researcher (short budget)',
    'Researcher, with half the step budget.',
    { run: { maxSteps: 50, withdraw: { afterStep: 25, tools: ['web_search', 'fetch_web_page'] } } },
  );

  const noWithdrawal = await derive(
    'Researcher (search kept)',
    'Researcher, with the search tools never withdrawn.',
    { run: { maxSteps: 100, withdraw: undefined } },
  );

  const now = new Date().toISOString();
  const experiment: Experiment = {
    id: uuidv4(),
    ownerId: OWNER,
    name: NAME,
    language: 'node',
    status: 'draft',
    results: [],
    repeats: 2,
    createdAt: now,
    updatedAt: now,
    variants: [
      { label: 'no-persona', overrides: { temperature: 0.4 } },
      { label: 'researcher', overrides: {}, packId: researcher.id },
      { label: 'short-budget', overrides: {}, packId: shortBudget.id },
      { label: 'search-kept', overrides: {}, packId: noWithdrawal.id },
    ],
    tasks: [
      {
        id: 'r1',
        name: 'narrow-answer-with-source',
        prompt:
          'Answer exactly one question: which software licence is the Restate durable-execution engine '
          + 'released under? Write the licence name and the URL you found it on to /work/answer.md. '
          + 'Two or three sentences is enough.',
        verifyCommand:
          'test -s /work/answer.md && grep -qiE "https?://" /work/answer.md '
          + '&& grep -qiE "BSL|business source|apache" /work/answer.md',
      },
      {
        id: 'r2',
        name: 'stays-inside-the-question',
        prompt:
          'Answer exactly one question: what is the default gRPC port that a Temporal frontend service '
          + 'listens on? Write the answer and its source URL to /work/port.md. Do not write about '
          + 'anything else — not installation, not pricing, not SDKs.',
        verifyCommand:
          'test -s /work/port.md && grep -q "7233" /work/port.md && grep -qiE "https?://" /work/port.md '
          + '&& test "$(wc -c < /work/port.md)" -lt 2000',
      },
      {
        id: 'r3',
        name: 'admits-what-it-cannot-find',
        prompt:
          'Answer exactly one question: what is the exact per-seat monthly list price of Restate Cloud '
          + 'for an on-premises air-gapped deployment? Write your answer to /work/price.md. '
          + 'If this is not published anywhere, say so plainly and say what you checked. Do not guess a number.',
        verifyCommand:
          'test -s /work/price.md && grep -qiE "not publish|no publish|not listed|unable|could not|not available|no public|contact" /work/price.md',
      },
      {
        id: 'r4',
        name: 'synthesises-without-searching',
        prompt:
          'Below are two answers that were researched separately. Combine them into one short piece and '
          + 'write it to /work/brief.md. Carry both source URLs through. Where they disagree, say so '
          + 'plainly rather than choosing one. Do not search for anything else.\n\n'
          + 'ANSWER A: Temporal is released under the MIT licence. Source: https://github.com/temporalio/temporal/blob/main/LICENSE\n'
          + 'ANSWER B: Restate is released under the Business Source License 1.1, converting to Apache 2.0 '
          + 'after four years. Source: https://github.com/restatedev/restate/blob/main/LICENSE',
        verifyCommand:
          'test -s /work/brief.md && grep -q "temporalio/temporal" /work/brief.md '
          + '&& grep -q "restatedev/restate" /work/brief.md '
          + '&& grep -qiE "MIT" /work/brief.md && grep -qiE "business source|BSL" /work/brief.md',
      },
    ],
  };

  await mongo.saveExperiment(experiment);
  console.log(`Seeded "${NAME}" (${experiment.id}) — ${experiment.variants.length} arms x ${experiment.tasks!.length} tasks x ${experiment.repeats} repeats`);
  process.exit(0);
}

main();

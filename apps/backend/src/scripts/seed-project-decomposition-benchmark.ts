/**
 * Seeds a dedicated Lab experiment for testing Project Planning & Leaf Decomposition.
 *
 * Exercises how models break down high-level architectural prompts into actionable,
 * distinct proposed leaves (e.g., GitHub API Client, K8s Resource Auditor CLI, Redis Caching Layer).
 */
import { createDatabase } from '../lib/db-interface.js';
import type { Experiment } from '../lib/experiments.js';

const DEMO_USER_ID = '2d5fe7e1-e7fc-4e88-8faf-8f08ba8b8991';

export async function seedProjectDecompositionExperiment() {
  const db = createDatabase();
  await db.init();

  const experimentId = 'exp-project-decomposition-001';
  const experiment: Experiment = {
    id: experimentId,
    ownerId: DEMO_USER_ID,
    name: 'GitHub API Client & Project Planning Decomposition Benchmark',
    description: 'Evaluates how models break down high-level project requests into 3–6 distinct, imperative proposed leaves.',
    repeats: 1,
    status: 'draft',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tasks: [
      {
        id: 'plan-t1',
        name: 'GitHub API Client for Framework Search',
        prompt: "Let's plan out an API client for the GitHub API so that we can search for code bases with specific frameworks.",
        verifyCommand: 'test -s /work/proposals.json && grep -q "leaves" /work/proposals.json',
      },
      {
        id: 'plan-t2',
        name: 'Kubernetes Resource Audit CLI',
        prompt: 'Plan out a CLI tool in TypeScript for auditing Kubernetes resource limits and CPU/memory requests across namespaces.',
        verifyCommand: 'test -s /work/proposals.json && grep -q "leaves" /work/proposals.json',
      },
      {
        id: 'plan-t3',
        name: 'Express Redis Caching Layer',
        prompt: 'Plan out a fast Redis caching layer with TTL eviction for Express REST API endpoints.',
        verifyCommand: 'test -s /work/proposals.json && grep -q "leaves" /work/proposals.json',
      },
    ],
    variants: [
      {
        label: 'standard-plan-mode',
        overrides: {
          temperature: 0.7,
          max_tokens: 3000,
          presence_penalty: 0.0,
          frequency_penalty: 0.0,
        },
      },
      {
        label: 'low-temp-schema-focused',
        overrides: {
          temperature: 0.2,
          max_tokens: 3000,
          presence_penalty: 0.0,
          frequency_penalty: 0.0,
        },
      },
      {
        label: 'dry-sampler-boosted',
        overrides: {
          temperature: 0.7,
          dry_multiplier: 0.8,
          dry_base: 1.75,
          dry_allowed_length: 2,
        },
      },
    ],
  };

  await db.saveExperiment(experiment);
  console.log(`[seed] Saved benchmark experiment "${experiment.name}" (ID: ${experiment.id})`);
}

// Run directly if invoked from CLI
if (process.argv[1]?.endsWith('seed-project-decomposition-benchmark.ts')) {
  seedProjectDecompositionExperiment()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

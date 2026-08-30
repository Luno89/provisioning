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
    repeats: 1,
    status: 'draft',
    language: 'node',
    results: [],
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
    variants: [] as { label: string; packId: string }[],
  };

  await db.saveExperiment(experiment);
  console.log(`[seed] Saved benchmark experiment "${experiment.name}" (ID: ${experiment.id})`);
}

if (process.argv[1]?.endsWith('seed-project-decomposition-benchmark.ts')) {
  seedProjectDecompositionExperiment()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

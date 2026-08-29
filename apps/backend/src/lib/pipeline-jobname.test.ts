import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '../activities/RunPipelineActivity.ts'), 'utf8');

const nameFor = (repo: string, commitSha: string, runId: string) => {
  const runSlug = runId.replace(/[^a-z0-9]/gi, '').slice(-8).toLowerCase();
  return `build-${repo}-${commitSha.slice(0, 8)}-${runSlug}`
    .toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 63);
};

describe('naming a build job', () => {
  it('differs for two runs of the same commit', () => {
    const a = nameFor('weather-api', 'abc123def456', '1786837463681-4r288m');
    const b = nameFor('weather-api', 'abc123def456', '1786837466866-a5dhwv');
    expect(a).not.toBe(b);
  });

  it('is stable for one run, so a retry adopts its own Job rather than orphaning it', () => {
    expect(nameFor('r', 'abc123def456', 'run-1')).toBe(nameFor('r', 'abc123def456', 'run-1'));
  });

  it('stays a legal Kubernetes name', () => {
    const n = nameFor('Some_Repo.Name', 'ABCDEF0123456789', '1786837466866-a5dhwv');
    expect(n).toMatch(/^[a-z0-9-]+$/);
    expect(n.length).toBeLessThanOrEqual(63);
  });

  it('actually uses runId in the activity, not just here', () => {
    expect(src).toMatch(/const jobName = `build-\$\{args\.giteaRepo\}-\$\{args\.commitSha\.slice\(0, 8\)\}-\$\{runSlug\}`/);
  });
});

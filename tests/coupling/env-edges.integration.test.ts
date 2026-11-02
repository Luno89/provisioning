import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chartEnv, envChannels } from './env-edges.js';
import { buildGraph, isTest } from './graph.js';

const ROOT = join(import.meta.dirname, 'fixture-http');
const graph = buildGraph({
  projects: [{ tsconfig: join(ROOT, 'tsconfig.json'), owns: () => true, readers: envChannels }],
  root: ROOT,
  calledFrom: (file) => !isTest(file),
  extraEnds: chartEnv(ROOT, 'chart', [[]]),
});

describe('env edges', () => {
  it('join each name the chart sets on Koala\'s own containers to the code that reads it, however it reads it', () => {
    expect(graph.edges.filter((edge) => edge.through === 'env').map((edge) => `${edge.site.file}:${edge.site.line} → ${edge.to.map((id) => graph.units[id]!.name).sort().join(' | ')}`).sort()).toEqual([
      'chart/templates/app.yaml:18 → settings',
      'chart/templates/app.yaml:22 → dbUrl',
      'chart/templates/app.yaml:24 → (anonymous)',
      'chart/templates/configmap-env.yaml:6 → settings',
    ]);
  });

  it('name what the chart sets that nothing reads, never a name only Kubernetes expands or another image\'s', () => {
    expect(graph.unmatched.filter((end) => end.side === 'sends').map((end) => end.name)).toEqual(['NOBODY_READS']);
  });
});

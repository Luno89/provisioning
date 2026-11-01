import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildGraph, isTest } from './graph.js';
import { httpChannels, httpMatches } from './http-routes.js';

const ROOT = join(import.meta.dirname, 'fixture-http');
const CLIENT = { file: /fixture-http\/src\/client\/api\.ts$/, name: 'api', base: '/api' };
const graph = buildGraph({
  projects: [{ tsconfig: join(ROOT, 'tsconfig.json'), owns: () => true, channels: (program) => httpChannels(program, [CLIENT]) }],
  root: ROOT,
  calledFrom: (file) => !isTest(file),
  matches: { http: httpMatches },
});
const at = (id: string) => `${graph.units[id]!.file}:${graph.units[id]!.line}`;

describe('HTTP edges', () => {
  it('join each call through the client or fetch to the handler of the route that serves it, however the route was made and mounted', () => {
    expect(graph.edges.filter((edge) => edge.through === 'http').map((edge) => `${graph.units[edge.from]!.name} → ${edge.to.map(at).join(' | ')}`).sort()).toEqual([
      'RootClient.decide → src/server/routes.ts:15',
      'RootClient.decide → src/server/routes.ts:15',
      'RootClient.notes → src/server/routes.ts:8',
      'acceptItem → src/server/routes.ts:16',
      'discardItem → src/server/routes.ts:15',
      'itemNotes → src/server/routes.ts:8',
      'openItem → src/server/routes.ts:14',
    ]);
  });

  it('name the calls no route serves and the routes nothing here calls, never a router no one mounts', () => {
    expect(graph.unmatched.map((end) => `${end.side} ${end.name}`).sort()).toEqual([
      'hears GET /install.sh',
      'sends GET /api/nowhere',
    ]);
  });
});

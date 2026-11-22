import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildGraph, isTest } from './graph.js';
import { httpChannels, httpMatches } from './http-routes.js';
import { shellEnds } from './shell-edges.js';

const ROOT = join(import.meta.dirname, 'fixture-http');
const CLIENT = { file: /fixture-http\/src\/client\/api\.ts$/, name: 'api', base: '/api' };
const SITE = { file: /fixture-http\/src\/client\/api\.ts$/, name: 'site', base: '' };
const graph = buildGraph({
  projects: [{ tsconfig: join(ROOT, 'tsconfig.json'), owns: () => true, channels: (program) => httpChannels(program, [CLIENT, SITE]) }],
  root: ROOT,
  calledFrom: (file) => !isTest(file),
  matches: { http: httpMatches },
  extraEnds: shellEnds(ROOT, 'scripts/install.sh'),
});
const at = (id: string) => `${graph.units[id]!.file}:${graph.units[id]!.line}`;

describe('HTTP edges', () => {
  it('join each call through the client, fetch or a script\'s curl to the handler of the route that serves it, however the route was made and mounted', () => {
    expect(graph.edges.filter((edge) => edge.through === 'http').map((edge) => `${graph.units[edge.from]!.name} → ${edge.to.map(at).join(' | ')}`).sort()).toEqual([
      '(script) → src/server/wiring.ts:11',
      'RootClient.decide → src/server/routes.ts:15',
      'RootClient.decide → src/server/routes.ts:15',
      'RootClient.notes → src/server/routes.ts:8',
      'acceptItem → src/server/routes.ts:16',
      'discardItem → src/server/routes.ts:15',
      'itemNotes → src/server/routes.ts:8',
      'login → src/server/sessions.ts:5',
      'openItem → src/server/routes.ts:14',
      'report → src/server/routes.ts:15',
    ]);
  });

  it('name the calls no route serves and the routes nothing here calls, never a router no one mounts', () => {
    expect(graph.unmatched.map((end) => `${end.side} ${end.name}`).sort()).toEqual([
      'sends GET /api/nowhere',
    ]);
  });
});

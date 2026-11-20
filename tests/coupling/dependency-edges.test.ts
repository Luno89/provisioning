import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildGraph, isTest } from './graph.js';

const ROOT = join(import.meta.dirname, 'fixture-deps');

const graph = buildGraph({
  projects: [{
    tsconfig: join(ROOT, 'tsconfig.json'),
    owns: () => true,
    records: () => (call) => (call.expression.getText() === 'writeFile' ? [{ collection: 'notes', writes: true }] : []),
  }],
  root: ROOT,
  calledFrom: (file) => !isTest(file),
  dependencies: (module) => module.startsWith('node:fs'),
});

describe('calls into an outside dependency', () => {
  it('keeps each call into a dependency the config names as an edge to that dependency\'s operation, with the record it touches in its path', () => {
    const into = graph.edges.filter((edge) => edge.through === 'dependency').map((edge) => ({ line: edge.site.line, to: edge.to, path: edge.path }));

    expect(into).toEqual([
      { line: 5, to: ['pkg:node:fs/promises#writeFile'], path: ['node:fs/promises', 'notes', 'writeFile'] },
      { line: 9, to: ['pkg:node:fs/promises#readFile'], path: ['node:fs/promises', 'readFile'] },
    ]);
  });

  it('leaves out calls into libraries the config does not name as dependencies', () => {
    expect(graph.edges.some((edge) => edge.to.some((to) => to.includes('node:path')))).toBe(false);
  });
});

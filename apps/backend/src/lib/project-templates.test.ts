import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { NODE_SERVICE_FILES, MCP_SERVER_FILES, LIBRARY_FILES } from './project-templates.js';
import { renderStarterFiles } from './tree-types.js';
import { TREE_TYPE_SEEDS } from './tree-type-seeds.js';

function materialise(files: { path: string; content: string }[], name = 'probe') {
  const dir = mkdtempSync(join(tmpdir(), 'tmpl-'));
  for (const f of renderStarterFiles(files, { projectName: name, registryHost: '' })) {
    mkdirSync(join(dir, dirname(f.path)), { recursive: true });
    writeFileSync(join(dir, f.path), f.content);
  }
  return dir;
}

describe('the api-service skeleton', () => {
  it('passes its own tests on a clean checkout', () => {
    const dir = materialise(NODE_SERVICE_FILES);
    const out = execSync('node --test test/*.test.js 2>&1', { cwd: dir, shell: '/bin/sh' }).toString();
    expect(out).toMatch(/# pass 1/);
    expect(out).toMatch(/# fail 0/);
  });

  it('listens on the port it is given, not a hardcoded one', () => {
    const dir = materialise(NODE_SERVICE_FILES);
    const out = execSync(
      'PORT=45231 node src/server.js & sleep 1; curl --noproxy "*" -s -o /dev/null -w "%{http_code}" http://127.0.0.1:45231/health; kill %1',
      { cwd: dir, shell: '/bin/bash' },
    ).toString();
    expect(out).toContain('200');
  });

  it('ships a Dockerfile, because without one the pipeline has nothing to build', () => {
    const files = renderStarterFiles(NODE_SERVICE_FILES, { projectName: 'probe', registryHost: '' });
    const docker = files.find((f) => f.path === 'Dockerfile');
    expect(docker).toBeTruthy();
    expect(docker!.content).toMatch(/^CMD/m);
  });

  it('uses the runtime test runner rather than an install', () => {
    const pkg = JSON.parse(renderStarterFiles(NODE_SERVICE_FILES, { projectName: 'probe', registryHost: '' }).find((f) => f.path === 'package.json')!.content);
    expect(pkg.scripts.test).toContain('node --test');
    expect(pkg.dependencies).toBeUndefined();
  });
});

describe('choosing a template', () => {
  it('gives a library no Dockerfile, because a library is not deployed', () => {
    const paths = renderStarterFiles(LIBRARY_FILES, { projectName: 'probe', registryHost: '' }).map((f) => f.path);
    expect(paths).not.toContain('Dockerfile');
    expect(paths).toContain('package.json');
  });

  it('gives nothing to a type that declares no starter files', () => {
    const withoutFiles = TREE_TYPE_SEEDS.filter((t) => !t.files.length);
    expect(withoutFiles.length).toBeGreaterThan(0);
    for (const seed of withoutFiles) {
      expect(renderStarterFiles(seed.files, { projectName: 'probe', registryHost: '' })).toEqual([]);
    }
  });

  it('names the repository in what it writes', () => {
    const pkg = JSON.parse(renderStarterFiles(NODE_SERVICE_FILES, { projectName: 'weather-api', registryHost: '' }).find((f) => f.path === 'package.json')!.content);
    expect(pkg.name).toBe('weather-api');
  });
});

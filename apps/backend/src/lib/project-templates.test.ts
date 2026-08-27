import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { NODE_SERVICE_FILES, MCP_SERVER_FILES, LIBRARY_FILES } from './project-templates.js';
import { renderStarterFiles } from './tree-types.js';
import { TREE_TYPE_SEEDS } from './tree-type-seeds.js';

/**
 * The template has to actually WORK, not merely exist.
 *
 * A test asserting `templateFor('api-service').length === 5` would pass for five files of garbage.
 * These write the skeleton to disk and run it, because every failure this template exists to
 * prevent — no Dockerfile, no PORT, no test runner — was a file that existed and was wrong.
 */
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
    /**
     * The point of the whole thing: the first leaf edits something that already works. If the
     * scaffold cannot pass `node --test` on the machine that wrote it, it is worse than nothing.
     */
    const dir = materialise(NODE_SERVICE_FILES);
    const out = execSync('node --test test/*.test.js 2>&1', { cwd: dir, shell: '/bin/sh' }).toString();
    expect(out).toMatch(/# pass 1/);
    expect(out).toMatch(/# fail 0/);
  });

  it('listens on the port it is given, not a hardcoded one', () => {
    // The measured failure: the deployment sets PORT and probes it, and a container binding
    // somewhere else looks like a broken application rather than a misconfigured one.
    const dir = materialise(NODE_SERVICE_FILES);
    const out = execSync(
      'PORT=45231 node src/server.js & sleep 1; curl --noproxy "*" -s -o /dev/null -w "%{http_code}" http://127.0.0.1:45231/health; kill %1',
      { cwd: dir, shell: '/bin/bash' },
    ).toString();
    expect(out).toContain('200');
  });

  it('ships a Dockerfile, because without one the pipeline has nothing to build', () => {
    // Measured: a repo with no Dockerfile had its build retried 622 times.
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
    // Otherwise the pipeline builds an image nobody wants and the tree reports a deployment.
    const paths = renderStarterFiles(LIBRARY_FILES, { projectName: 'probe', registryHost: '' }).map((f) => f.path);
    expect(paths).not.toContain('Dockerfile');
    expect(paths).toContain('package.json');
  });

  it('gives nothing to a type that declares no starter files', () => {
    /**
     * A skeleton dropped into a migration or an investigation is noise the first leaf deletes. That
     * used to be a `default: return []` in a switch; it is now simply a type whose record carries an
     * empty `files`, which is why this asserts over the SEEDS rather than over a list of names.
     */
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

import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { templateFor } from './project-templates.js';

/**
 * The template has to actually WORK, not merely exist.
 *
 * A test asserting `templateFor('api-service').length === 5` would pass for five files of garbage.
 * These write the skeleton to disk and run it, because every failure this template exists to
 * prevent — no Dockerfile, no PORT, no test runner — was a file that existed and was wrong.
 */
function materialise(type: string, name = 'probe') {
  const dir = mkdtempSync(join(tmpdir(), 'tmpl-'));
  for (const f of templateFor(type, name)) {
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
    const dir = materialise('api-service');
    const out = execSync('node --test test/*.test.js 2>&1', { cwd: dir, shell: '/bin/sh' }).toString();
    expect(out).toMatch(/# pass 1/);
    expect(out).toMatch(/# fail 0/);
  });

  it('listens on the port it is given, not a hardcoded one', () => {
    // The measured failure: the deployment sets PORT and probes it, and a container binding
    // somewhere else looks like a broken application rather than a misconfigured one.
    const dir = materialise('api-service');
    const out = execSync(
      'PORT=45231 node src/server.js & sleep 1; curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:45231/health; kill %1',
      { cwd: dir, shell: '/bin/bash' },
    ).toString();
    expect(out).toContain('200');
  });

  it('ships a Dockerfile, because without one the pipeline has nothing to build', () => {
    // Measured: a repo with no Dockerfile had its build retried 622 times.
    const files = templateFor('api-service', 'probe');
    const docker = files.find((f) => f.path === 'Dockerfile');
    expect(docker).toBeTruthy();
    expect(docker!.content).toMatch(/^CMD/m);
  });

  it('uses the runtime test runner rather than an install', () => {
    const pkg = JSON.parse(templateFor('api-service', 'probe').find((f) => f.path === 'package.json')!.content);
    expect(pkg.scripts.test).toContain('node --test');
    expect(pkg.dependencies).toBeUndefined();
  });
});

describe('choosing a template', () => {
  it('gives a library no Dockerfile, because a library is not deployed', () => {
    // Otherwise the pipeline builds an image nobody wants and the tree reports a deployment.
    const paths = templateFor('library', 'probe').map((f) => f.path);
    expect(paths).not.toContain('Dockerfile');
    expect(paths).toContain('package.json');
  });

  it('gives nothing to trees that work on code which already exists', () => {
    // A skeleton dropped into a migration or an investigation is noise the first leaf deletes.
    for (const t of ['research-paper', 'migration', 'investigation', 'benchmark', undefined]) {
      expect(templateFor(t, 'probe')).toEqual([]);
    }
  });

  it('names the repository in what it writes', () => {
    const pkg = JSON.parse(templateFor('api-service', 'weather-api').find((f) => f.path === 'package.json')!.content);
    expect(pkg.name).toBe('weather-api');
  });
});

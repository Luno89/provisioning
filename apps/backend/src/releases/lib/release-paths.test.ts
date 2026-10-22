import { describe, it, expect } from 'vitest';
import { changedPaths, globPattern, releaseDecision, releasePathsProblem } from './release-paths.js';

describe('the paths an app is built from', () => {
  it('match a file, a folder at any depth, and a name pattern', () => {
    expect(globPattern('Dockerfile').test('Dockerfile')).toBe(true);
    expect(globPattern('Dockerfile').test('docs/Dockerfile')).toBe(false);
    expect(globPattern('addons/**').test('addons/shop/models/order.py')).toBe(true);
    expect(globPattern('addons/**').test('addons.md')).toBe(false);
    expect(globPattern('**/*.py').test('a/b/c.py')).toBe(true);
    expect(globPattern('**/*.py').test('c.py')).toBe(true);
    expect(globPattern('package*.json').test('package-lock.json')).toBe(true);
    expect(globPattern('src/*.ts').test('src/deep/a.ts')).toBe(false);
  });

  it('are compared between two commits by what each file holds', () => {
    const before = new Map([['PLAN.md', 'a'], ['addons/x.py', 'b'], ['gone.txt', 'c']]);
    const after = new Map([['PLAN.md', 'a2'], ['addons/x.py', 'b'], ['new.md', 'd']]);
    expect(changedPaths(before, after)).toEqual(['PLAN.md', 'gone.txt', 'new.md']);
  });
});

describe('whether a build is released', () => {
  const odoo = ['Dockerfile', 'addons/**', 'deploy/chart/**'];

  it('is released when anything the app is built from changed, or when the type says nothing about it', () => {
    expect(releaseDecision(['PLAN.md', 'addons/shop/__manifest__.py'], odoo, 'abcdef123')).toEqual({ release: true });
    expect(releaseDecision(['PLAN.md'], undefined, 'abcdef123')).toEqual({ release: true });
    expect(releaseDecision(['PLAN.md'], [], 'abcdef123')).toEqual({ release: true });
  });

  it('is not released when only other files changed, and says which', () => {
    expect(releaseDecision(['PLAN.md', 'README.md'], odoo, 'abcdef1234')).toEqual({ release: false, reason: 'only PLAN.md, README.md changed since abcdef12, none of which the app is built from' });
    expect(releaseDecision(['a', 'b', 'c', 'd', 'e', 'f', 'g'], odoo, 'abcdef1234')).toEqual({ release: false, reason: 'only a, b, c, d, e and 2 more changed since abcdef12, none of which the app is built from' });
    expect(releaseDecision([], odoo, 'abcdef1234')).toEqual({ release: false, reason: 'nothing changed since abcdef12' });
  });

  it('takes only relative paths inside the repository', () => {
    expect(releasePathsProblem(['src/**', 'Dockerfile'])).toBeNull();
    expect(releasePathsProblem('src/**')).toMatch(/must be a list/);
    expect(releasePathsProblem(['/etc/passwd'])).toMatch(/must be relative/);
    expect(releasePathsProblem(['../x'])).toMatch(/must be relative/);
    expect(releasePathsProblem([''])).toMatch(/has to be a path/);
  });
});

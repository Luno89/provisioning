import { describe, expect, it } from 'vitest';
import { contributionsOf, readWorkspaceFile, workspaceFileProblems, pendingChanges, withChange, writeWorkspaceFile } from './workspace-file.js';

describe('a project\'s .koala/workspace.json', () => {
  const file = { packages: { dnf: ['wkhtmltopdf'], pip: ['lxml==5.2.1'] }, script: 'curl -fsSL https://example.test/install.sh | sh', languages: ['python'], env: [{ name: 'SHOP', value: 'demo' }] };

  it('reads one that says what the workspace needs, and an absent or empty one as needing nothing', () => {
    expect(readWorkspaceFile(JSON.stringify(file))).toEqual({ file });
    expect(readWorkspaceFile(undefined)).toEqual({ file: {} });
    expect(readWorkspaceFile('  ')).toEqual({ file: {} });
  });

  it('says what is wrong with one it cannot use', () => {
    expect(readWorkspaceFile('{ nope')).toEqual({ problems: [expect.stringMatching(/^\.koala\/workspace\.json is not JSON/)] });
    expect(workspaceFileProblems({ packages: { brew: ['x'], dnf: ['ok', 'not ok'] }, script: ' ', languages: ['cobol'], env: [{ name: 'DB_PASSWORD', value: 'x' }, { name: '1X', value: 'y' }], extra: 1 })).toEqual([
      '"extra" is not something .koala/workspace.json can say; it can say packages, script, languages, needs, env',
      '"brew" is not a package manager it can use; it can use dnf, apt, pip, npm',
      '"not ok" in packages.dnf is not a package name',
      'script has to be the shell commands to run, as one string',
      '"cobol" is not a language a workspace can have; it can have node, python, go',
      '"DB_PASSWORD" looks like a secret, and secrets never go in .koala/workspace.json: a model works in this workspace',
      '"1X" is not an environment variable name',
    ]);
  });

  it('becomes the project\'s lines of the image, packages then its script', () => {
    expect(contributionsOf(file)).toEqual([
      { from: 'project', install: { via: 'dnf', packages: ['wkhtmltopdf'] } },
      { from: 'project', install: { via: 'pip', packages: ['lxml==5.2.1'] } },
      { from: 'project', install: { via: 'script', run: 'curl -fsSL https://example.test/install.sh | sh' } },
    ]);
  });

  it('writes back as the same file, readably', () => {
    expect(readWorkspaceFile(writeWorkspaceFile(file))).toEqual({ file });
    expect(writeWorkspaceFile(file).endsWith('\n')).toBe(true);
  });
});

describe('adding what an agent asks for to the file', () => {
  const file = { packages: { dnf: ['wkhtmltopdf'] }, env: [{ name: 'SHOP', value: 'demo' }] };

  it('adds only what is new, and says what it added', () => {
    expect(withChange(file, { packages: { dnf: ['wkhtmltopdf', 'jq'], pip: ['pandas'] }, languages: ['python'], env: [{ name: 'SHOP', value: 'demo' }, { name: 'MODE', value: 'test' }] })).toEqual({
      file: { packages: { dnf: ['wkhtmltopdf', 'jq'], pip: ['pandas'] }, languages: ['python'], env: [{ name: 'SHOP', value: 'demo' }, { name: 'MODE', value: 'test' }] },
      added: ['dnf jq', 'pip pandas', 'the python language', 'MODE=test'],
    });
  });

  it('adds nothing when everything asked for is there already, a script included', () => {
    const scripted = { ...file, script: 'curl -fsSL https://x.test | sh' };
    expect(withChange(scripted, { packages: { dnf: ['wkhtmltopdf'] }, script: 'curl -fsSL https://x.test | sh' })).toEqual({ file: scripted, added: [] });
  });

  it('puts a new script after the one the file runs', () => {
    expect(withChange({ script: 'echo one' }, { script: 'echo two' })).toEqual({ file: { script: 'echo one\necho two' }, added: ['an install script'] });
  });

  it('refuses what the file could not say, a secret above all', () => {
    expect(withChange(file, { env: [{ name: 'DB_PASSWORD', value: 'x' }] })).toEqual({ problems: [expect.stringContaining('looks like a secret')] });
    expect(withChange(file, { languages: ['cobol'] })).toEqual({ problems: [expect.stringContaining('"cobol" is not a language')] });
  });
});

describe('what the file on main has that the published workspace does not', () => {
  it('is what was added since it was built', () => {
    expect(pendingChanges({ packages: { dnf: ['jq'] } }, { packages: { dnf: ['jq', 'ripgrep'] }, script: 'echo hi' })).toEqual(['dnf ripgrep', 'an install script']);
    expect(pendingChanges({ packages: { dnf: ['jq'] } }, { packages: { dnf: ['jq'] } })).toEqual([]);
  });

  it('is nothing before the tree has a workspace, which is composed from main when it is first wanted', () => {
    expect(pendingChanges(undefined, { packages: { dnf: ['jq'] } })).toEqual([]);
  });

  it('names the dependencies the workspace needs, adds them by a change once each, and never drops one', () => {
    expect(workspaceFileProblems({ needs: 'koala-e2e' })).toEqual(['needs has to be a list of dependency names']);
    expect(workspaceFileProblems({ needs: ['Koala E2E'] })).toEqual(['"Koala E2E" in needs is not a dependency name']);
    expect(contributionsOf({ needs: ['koala-e2e'] })).toEqual([]);
    expect(withChange({ packages: { dnf: ['jq'] } }, { needs: ['koala-e2e'] })).toEqual({ file: { packages: { dnf: ['jq'] }, needs: ['koala-e2e'] }, added: ['the koala-e2e dependency'] });
    expect(withChange({ needs: ['koala-e2e'] }, { needs: ['koala-e2e', 'jq'] })).toEqual({ file: { needs: ['koala-e2e', 'jq'] }, added: ['the jq dependency'] });
    expect(pendingChanges({}, { needs: ['koala-e2e'] })).toEqual(['the koala-e2e dependency']);
  });
});

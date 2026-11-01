import { describe, expect, it } from 'vitest';
import { dependencyFrom } from './workspace-dependencies.js';

describe('dependencyFrom', () => {
  it('reads a dependency a person sent', () => {
    expect(dependencyFrom({ name: 'pdf-tools', summary: 'PDF tools.', provides: ['pdftotext'], install: [{ via: 'dnf', packages: ['poppler-utils'] }], onDebian: [{ via: 'script', run: 'apt-get install -y poppler-utils' }] })).toEqual({
      ok: true,
      dependency: { name: 'pdf-tools', summary: 'PDF tools.', provides: ['pdftotext'], install: [{ via: 'dnf', packages: ['poppler-utils'] }], onDebian: [{ via: 'script', run: 'apt-get install -y poppler-utils' }] },
    });
  });

  it('leaves what is missing for the dependency rules to name', () => {
    expect(dependencyFrom({ name: 'pdf-tools' })).toEqual({ ok: true, dependency: { name: 'pdf-tools', summary: '', provides: [], install: [] } });
  });

  it('refuses a shape it cannot read', () => {
    expect(dependencyFrom({})).toEqual({ ok: false, problem: 'a dependency needs a name' });
    expect(dependencyFrom({ name: 'x', provides: 'jq' })).toEqual({ ok: false, problem: 'provides has to be a list of names' });
    expect(dependencyFrom({ name: 'x', install: [{ via: 'brew', packages: ['jq'] }] })).toMatchObject({ ok: false });
    expect(dependencyFrom({ name: 'x', install: 'dnf install jq' })).toEqual({ ok: false, problem: 'install has to be a list of installs' });
  });
});

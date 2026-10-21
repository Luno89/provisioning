import { describe, expect, it } from 'vitest';
import { dependencyProblems, LANGUAGE_DEPENDENCIES, LANGUAGE_IDS } from './dependencies.js';

describe('a workspace dependency', () => {
  it('says what it gives, how it installs and what it puts on the PATH', () => {
    expect(LANGUAGE_DEPENDENCIES.flatMap(dependencyProblems)).toEqual([]);
    expect(LANGUAGE_IDS).toEqual(['node', 'python', 'go']);
  });

  it('is refused when it could never be proved or never install anything', () => {
    expect(dependencyProblems({ name: 'Bad Name', summary: '', provides: [], install: [] })).toEqual([
      '"Bad Name" is not a dependency name: lower-case letters, digits and dashes, starting with a letter',
      'Bad Name needs a one-line summary of what it gives a workspace',
      'Bad Name has to say which programs it puts on the PATH, or which libraries it adds, so a build can prove it did',
      'Bad Name has to say how it is installed',
    ]);
    expect(dependencyProblems({ name: 'jq', summary: 'jq.', provides: ['jq'], needs: ['jq'], install: [{ via: 'dnf', packages: [] }, { via: 'base' }] })).toEqual([
      'jq has an install that installs nothing',
      'jq cannot install "nothing"; a base image that already has it says so itself',
      'jq cannot need itself',
    ]);
  });
});

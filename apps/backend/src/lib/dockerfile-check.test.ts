import { describe, it, expect } from 'vitest';
import { checkDockerfile, isIgnored, describeDockerfileProblems } from './dockerfile-check.js';

/**
 * Catching the Dockerfile mistakes that only show up in a build.
 *
 * ── THE REAL ONE ──
 * Reproduced verbatim below. A leaf rewrote a working Dockerfile into a multi-stage build, copied
 * `package.json` without `package-lock.json`, and ran `npm ci`. Every build failed; the leaf was
 * marked succeeded AND verified, because verification runs `node --test` and the suite never reads
 * the Dockerfile. The deploy then retried 54 times over ninety minutes and starved the queue.
 *
 * ── AND WHY MOST OF THIS IS NEGATIVE CASES ──
 * A check that fires on something merely unusual gets turned off within a week, and then catches
 * nothing at all. Everything here is a DEFINITE fault.
 */

const FILES = ['package.json', 'package-lock.json', 'src/server.js', 'test/server.test.js', 'Dockerfile'];

describe('the Dockerfile that broke the build', () => {
  it('catches it, exactly as written', () => {
    const dockerfile = `
# ── Build stage: install production dependencies ──
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm ci --omit=dev

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY src/ ./src/
CMD ["node", "src/server.js"]
`;
    const problems = checkDockerfile(dockerfile, FILES);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.problem).toMatch(/npm ci.*package-lock\.json/);
    // Says what this stage DID copy, because "it is missing" without "here is what you have" is
    // the half of the message that does not help.
    expect(problems[0]!.problem).toContain('package.json');
    expect(problems[0]!.fix).toContain('COPY package.json package-lock.json');
  });

  it('is per stage, which is why the bug was invisible to a reader', () => {
    /**
     * A multi-stage build resets the filesystem at every FROM. The COPY and the RUN were adjacent
     * and looked complete; the lockfile a LATER stage copied never existed in the stage that
     * needed it.
     */
    const dockerfile = `
FROM node:22 AS build
COPY package.json ./
RUN npm ci

FROM node:22
COPY package.json package-lock.json ./
`;
    expect(checkDockerfile(dockerfile, FILES)).toHaveLength(1);
  });
});

describe('what it must NOT complain about', () => {
  it('accepts the template, which was correct all along', () => {
    // The scaffold guarded its install. Firing on the shipped template would be the fastest way to
    // get the whole check disabled.
    const dockerfile = `
FROM node:22-alpine
WORKDIR /app
COPY . .
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; fi
EXPOSE 8080
CMD ["node", "src/server.js"]
`;
    expect(checkDockerfile(dockerfile, FILES)).toEqual([]);
  });

  it('accepts a lockfile copied explicitly', () => {
    const dockerfile = 'FROM node:22\nCOPY package.json package-lock.json ./\nRUN npm ci\nCOPY src/ ./src/\nCMD ["node", "src/server.js"]';
    expect(checkDockerfile(dockerfile, FILES)).toEqual([]);
  });

  it('accepts npm install, which needs no lockfile', () => {
    // Only `npm ci` has this requirement. Complaining about `npm install` would be an opinion.
    const dockerfile = 'FROM node:22\nCOPY package.json ./\nRUN npm install --omit=dev';
    expect(checkDockerfile(dockerfile, FILES)).toEqual([]);
  });

  it('reads a RUN split across continuation lines', () => {
    // Long RUN commands are written this way, and a line-by-line reader misses half of them.
    const dockerfile = 'FROM node:22\nCOPY . .\nRUN apk add --no-cache git \\\n  && npm ci --omit=dev \\\n  && npm cache clean --force';
    expect(checkDockerfile(dockerfile, FILES)).toEqual([]);
  });

  it('ignores comments, including one that mentions npm ci', () => {
    const dockerfile = 'FROM node:22\n# we used to RUN npm ci here\nCOPY package.json ./\nRUN npm install';
    expect(checkDockerfile(dockerfile, FILES)).toEqual([]);
  });
});

describe('telling apart the ways a lockfile can be absent', () => {
  it('says the repository has none, when it has none', () => {
    // A different problem needing a different fix: commit a lockfile, do not edit the COPY.
    const problems = checkDockerfile('FROM node:22\nCOPY . .\nRUN npm ci', ['package.json', 'src/server.js']);
    expect(problems[0]!.problem).toMatch(/repository does not have one/);
    expect(problems[0]!.fix).toMatch(/npm install/);
  });

  it('says .dockerignore is excluding it, when it is', () => {
    /**
     * The nastiest version: the file is committed, the COPY looks right, and the build context
     * silently does not contain it.
     */
    const problems = checkDockerfile('FROM node:22\nCOPY . .\nRUN npm ci', FILES, 'node_modules/\npackage-lock.json\n');
    expect(problems[0]!.problem).toMatch(/dockerignore excludes it/);
    expect(problems[0]!.fix).toMatch(/Remove package-lock\.json from \.dockerignore/);
  });
});

describe('the file the container actually runs', () => {
  it('catches a CMD whose script was never copied', () => {
    const dockerfile = 'FROM node:22\nCOPY package.json package-lock.json ./\nRUN npm ci\nCMD ["node", "src/server.js"]';
    const problems = checkDockerfile(dockerfile, FILES);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.problem).toContain('src/server.js');
    expect(problems[0]!.fix).toContain('COPY src/');
  });

  it('says nothing when the repository has no such file', () => {
    // Then the CMD is about something built during the image, and a static reader cannot know.
    const dockerfile = 'FROM node:22\nCOPY . .\nRUN npm run build\nCMD ["node", "dist/main.js"]';
    expect(checkDockerfile(dockerfile, ['package.json', 'package-lock.json'])).toEqual([]);
  });
});

describe('.dockerignore matching', () => {
  it('matches names, directories and simple suffixes', () => {
    expect(isIgnored('package-lock.json', 'package-lock.json')).toBe(true);
    expect(isIgnored('test/server.test.js', 'test/')).toBe(true);
    expect(isIgnored('debug.log', '*.log')).toBe(true);
  });

  it('stays silent on a negation rather than guessing', () => {
    // `!pattern` re-includes. Getting that wrong would produce a confident, wrong accusation.
    expect(isIgnored('package-lock.json', '*.json\n!package-lock.json')).toBe(false);
  });

  it('is false when there is no .dockerignore at all', () => {
    expect(isIgnored('anything', undefined)).toBe(false);
  });
});

describe('what the agent is told', () => {
  it('says nothing at all when the Dockerfile is fine', () => {
    expect(describeDockerfileProblems([])).toBe('');
  });

  it('gives the line, the problem and the fix', () => {
    const problems = checkDockerfile('FROM node:22\nCOPY package.json ./\nRUN npm ci', FILES);
    const text = describeDockerfileProblems(problems);
    expect(text).toMatch(/line 3/);
    expect(text).toMatch(/cannot build/i);
    expect(text).toMatch(/fix:/);
  });
});

describe('a multi-stage build for a project with no dependencies', () => {
  /**
   * The third fault of the same family, and the subtlest: every instruction is individually
   * correct and the whole is unbuildable. Kaniko reports
   * `lstat /kaniko/0/app/node_modules: no such file or directory` — a path inside the builder that
   * says nothing about the cause.
   */
  const multiStage = `
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY src/ ./src/
CMD ["node", "src/server.js"]`;

  it('catches the copy when there are no dependencies', () => {
    const problems = checkDockerfile(multiStage, FILES, undefined, false);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.problem).toMatch(/declares no dependencies/);
    expect(problems[0]!.fix).toMatch(/Drop the build stage/);
  });

  it('says nothing when the project DOES have dependencies', () => {
    // Then the multi-stage build is the right shape and this is a normal, working Dockerfile.
    expect(checkDockerfile(multiStage, FILES, undefined, true)).toEqual([]);
  });

  it('says nothing when the caller could not determine the dependencies', () => {
    // Unknown is not "none". Guessing would fire on every correct multi-stage build whose
    // package.json the caller failed to read.
    expect(checkDockerfile(multiStage, FILES)).toEqual([]);
  });
});

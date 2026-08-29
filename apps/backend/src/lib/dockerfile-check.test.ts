import { describe, it, expect } from 'vitest';
import { checkDockerfile, isIgnored, describeDockerfileProblems } from './dockerfile-check.js';

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
    expect(problems[0]!.problem).toContain('package.json');
    expect(problems[0]!.fix).toContain('COPY package.json package-lock.json');
  });

  it('is per stage, which is why the bug was invisible to a reader', () => {
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
    const dockerfile = 'FROM node:22\nCOPY package.json ./\nRUN npm install --omit=dev';
    expect(checkDockerfile(dockerfile, FILES)).toEqual([]);
  });

  it('reads a RUN split across continuation lines', () => {
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
    const problems = checkDockerfile('FROM node:22\nCOPY . .\nRUN npm ci', ['package.json', 'src/server.js']);
    expect(problems[0]!.problem).toMatch(/repository does not have one/);
    expect(problems[0]!.fix).toMatch(/npm install/);
  });

  it('says .dockerignore is excluding it, when it is', () => {
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
    expect(checkDockerfile(multiStage, FILES, undefined, true)).toEqual([]);
  });

  it('says nothing when the caller could not determine the dependencies', () => {
    expect(checkDockerfile(multiStage, FILES)).toEqual([]);
  });
});

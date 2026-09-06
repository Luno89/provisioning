import { describe, it, expect, vi } from 'vitest';
import { checkLeafDockerfile } from './leaf-docker-check.js';

const BROKEN_DOCKERFILE = `
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

const workspace = (files: Record<string, string>) => ({
  exec: vi.fn(async () => ({
    stdout: 'package.json\npackage-lock.json\nsrc/server.js\ntest/server.test.js\nDockerfile\n',
    stderr: '', exitCode: 0,
  })),
  readFile: vi.fn(async (_leafId: string, path: string) => {
    const key = path.replace('/work/repo/', '');
    if (!(key in files)) throw new Error('not found');
    return files[key]!;
  }),
});

describe('checkLeafDockerfile', () => {
  it('reports nothing when there is no Dockerfile', async () => {
    const ws = workspace({});
    expect(await checkLeafDockerfile(ws, 'l1')).toBe('');
    expect(ws.exec).not.toHaveBeenCalled();
  });

  it('reports the missing lockfile problem, exactly as the inline check used to', async () => {
    const ws = workspace({ Dockerfile: BROKEN_DOCKERFILE, 'package.json': '{"dependencies":{"x":"1"}}' });
    const out = await checkLeafDockerfile(ws, 'l1');
    expect(out).toMatch(/npm ci.*package-lock\.json/);
  });

  it('treats an unparseable package.json as unknown rather than throwing', async () => {
    const ws = workspace({ Dockerfile: BROKEN_DOCKERFILE, 'package.json': 'not json' });
    await expect(checkLeafDockerfile(ws, 'l1')).resolves.toBeTypeOf('string');
  });
});

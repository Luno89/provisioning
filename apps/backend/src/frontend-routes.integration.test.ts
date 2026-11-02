import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, inject, it } from 'vitest';
import ts from 'typescript';
import { clientCallsIn, served, type Route } from '../../../tests/coupling/http-edges.js';
import { isTest } from '../../../tests/coupling/graph.js';
import { httpChannels } from '../../../tests/coupling/http-routes.js';
import { devSplitPlan, generateIdentityKey, hashCredential, publicKeyPem } from './instances/index.js';
import { identityKeysFrom } from './instances/lib/identity-token.js';

const BACKEND = join(dirname(fileURLToPath(import.meta.url)), '..');
const FRONTEND = join(BACKEND, '../frontend/src');

function routesFor(env: Record<string, string>): Promise<Route[]> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['tsx', '../../tests/coupling/print-routes.mts'], { cwd: BACKEND, env: { ...process.env, NODE_ENV: 'development', ...env, PORT: '0', MACHINE_GATEWAY_PORT: '0', TEMPORAL_METRICS_PORT: '0' } });
    let out = '';
    let said = '';
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { said = `${said}${chunk.toString()}`.slice(-3000); });
    child.on('close', (code) => {
      const line = out.split('\n').find((entry) => entry.startsWith('KOALA-ROUTES '));
      if (line) resolve(JSON.parse(line.slice('KOALA-ROUTES '.length)) as Route[]);
      else reject(new Error(`the ${env.ROLE} backend ended (${code}) without printing its routes: ${said.trim().split('\n').filter((entry) => !/stream worker not started|TS bridge not available/.test(entry)).slice(-8).join(' | ')}`));
    });
  });
}

const byRole: Record<string, Route[]> = {};

const MOUNTED_ONLY_ELSEWHERE: Record<string, string> = {
  'GET /^(?!\\/api).*': 'the built frontend, served only in production',
  'GET /api/move/parts/:part': 'a pool instance, which serves its parts while it moves to its owner\'s machine',
  'POST /api/move/thaw': 'a pool instance, thawed by root when its move ends',
};

beforeAll(async () => {
  const mongo = inject('mongoUri');
  const signing = identityKeysFrom(generateIdentityKey());
  const plan = devSplitPlan({
    name: 'dev', owner: { id: 'owner-1', email: 'owner@example.com', createdAt: 'then' } as never, instanceId: 'inst-1', credential: 'c', credentialHash: hashCredential('c'),
    hubCredential: 'h', hubCredentialHash: hashCredential('h'), rootPublicKeys: publicKeyPem(signing.publicKey), mongoUri: `${mongo}t_${randomUUID().slice(0, 8)}`, now: 'then',
  });
  const own = (database: string) => ({ MONGO_URI: `${mongo}${database}_${randomUUID().slice(0, 8)}` });
  const roles = { combined: { ROLE: 'combined', ...own('combined') }, root: { ...plan.rootEnv, ...own('root') }, instance: { ...plan.instanceEnv, ...own('instance') }, hub: { ...plan.hubEnv, ...own('hub') } };
  await Promise.all(Object.entries(roles).map(async ([role, env]) => { byRole[role] = await routesFor(env as Record<string, string>); }));
}, 240_000);

describe('every call the frontend makes is one some backend serves', () => {
  it('reads each role\'s routes from Express itself', () => {
    expect(Object.keys(byRole).sort()).toEqual(['combined', 'hub', 'instance', 'root']);
    expect(byRole.combined).toContainEqual({ method: 'GET', path: '/api/auth/me' });
    expect(byRole.instance).toContainEqual({ method: 'GET', path: '/api/auth/account-removal' });
  });

  it('finds a route of the same method and shape for each of the frontend\'s calls, and can read every path the frontend names', () => {
    const everywhere = Object.values(byRole).flat();
    const { calls, unread } = clientCallsIn(FRONTEND, join(FRONTEND, '..'));
    expect(calls.length).toBeGreaterThan(300);
    expect(calls.filter((call) => !served(call, everywhere)).map((call) => `${call.method} ${call.path} (${call.file}:${call.line})`)).toEqual([]);
    expect(unread.map((call) => `${call.file}:${call.line} ${call.text}`)).toEqual([]);
  });

  it('mounts exactly the routes the coupling graph reads from the code without running it', () => {
    const config = ts.getParsedCommandLineOfConfigFile(join(BACKEND, 'tsconfig.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (problem) => { throw new Error(String(problem.messageText)); } });
    if (!config) throw new Error('the backend tsconfig could not be read');
    const program = ts.createProgram(config.fileNames, { ...config.options, noEmit: true });
    const ends = httpChannels(program, []);
    const read = new Set<string>();
    for (const source of program.getSourceFiles()) {
      if (source.isDeclarationFile || source.fileName.includes('/node_modules/') || isTest(source.fileName)) continue;
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node)) for (const end of ends(node) ?? []) if (end.side === 'hears') read.add(end.name);
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    const mounted = new Set(Object.values(byRole).flat().map((route) => `${route.method} ${route.path}`));
    expect([...mounted].filter((route) => !read.has(route)).sort()).toEqual([]);
    expect([...read].filter((route) => !mounted.has(route)).sort()).toEqual(Object.keys(MOUNTED_ONLY_ELSEWHERE).sort());
  }, 120_000);
});

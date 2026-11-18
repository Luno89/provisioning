import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';
import * as workflows from './workflows/index.js';
import { BY_TYPE, HIDDEN_TYPES } from './infrastructure/lib/running.js';
import { FAILURE_SHOWN_ON_RECORD } from './infrastructure/lib/work-failures.js';
import { STARTED_ON, temporalWorld, WORKERS, type TemporalWorld } from '../../../tests/coupling/temporal-edges.js';
import { HOST_ACTIVITIES, roleRuns, WORKFLOWS } from './platform/index.js';

const SRC = dirname(fileURLToPath(import.meta.url));
const FRONTEND = resolve(SRC, '../../frontend/src');

let world: TemporalWorld;
let program: ts.Program;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return entry === 'node_modules' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [path] : [];
  });
}

beforeAll(() => {
  const configPath = join(SRC, '../tsconfig.json');
  const config = ts.getParsedCommandLineOfConfigFile(configPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (problem) => { throw new Error(String(problem.messageText)); } });
  if (!config) throw new Error('the backend tsconfig could not be read');
  const workflowFiles = readdirSync(join(SRC, 'workflows')).filter((entry) => entry.endsWith('.ts') && !entry.endsWith('.test.ts')).map((entry) => join(SRC, 'workflows', entry));
  program = ts.createProgram([...workflowFiles, ...Object.values(WORKERS).map((file) => join(SRC, file))], { ...config.options, noEmit: true });
  world = temporalWorld(program, SRC);
});

describe('what each workflow calls is what its worker runs', () => {
  it('knows which queue every workflow is started on', () => {
    expect(Object.keys(STARTED_ON).sort()).toEqual(Object.keys(workflows).sort());
  });

  it('finds every worker\'s activities', () => {
    for (const [queue, names] of Object.entries(world.registered)) expect(names.size, `${queue} worker`).toBeGreaterThan(0);
  });

  it('registers every activity a workflow can call on the worker of the queue it calls it on', () => {
    const missing: string[] = [];
    for (const [name, queue] of Object.entries(STARTED_ON)) {
      for (const file of world.reachable(name)) {
        for (const proxy of world.proxies.get(file) ?? []) {
          if (proxy.queue === 'device') continue;
          const on = proxy.queue === 'own' ? queue : proxy.queue;
          for (const activity of proxy.activities) {
            if (!world.registered[on].has(activity)) missing.push(`${name} (${file.slice(SRC.length + 1)}) calls ${activity} on the ${on} queue, whose worker does not run it`);
          }
        }
      }
    }
    expect([...new Set(missing)]).toEqual([]);
  });

  it('registers each activity as a function taking no more than what the workflow calling it passes', () => {
    const checker = program.getTypeChecker();
    const required = (node: ts.Node): number | undefined => {
      const value = ts.isPropertyAssignment(node) ? node.initializer : ts.isShorthandPropertyAssignment(node) ? node.name : node;
      const signature = checker.getTypeAtLocation(value).getCallSignatures()[0];
      if (!signature) return undefined;
      return signature.getParameters().filter((parameter) => {
        const declaration = parameter.valueDeclaration;
        return !(declaration && ts.isParameter(declaration) && (declaration.questionToken || declaration.initializer || declaration.dotDotDotToken));
      }).length;
    };
    const wrong: string[] = [];
    for (const [name, queue] of Object.entries(STARTED_ON)) {
      for (const file of world.reachable(name)) {
        for (const proxy of world.proxies.get(file) ?? []) {
          if (proxy.queue === 'device') continue;
          const on = proxy.queue === 'own' ? queue : proxy.queue;
          const proxied = checker.getTypeAtLocation(proxy.call);
          for (const activity of proxy.activities) {
            const member = proxied.getProperty(activity);
            const given = member ? checker.getTypeOfSymbolAtLocation(member, proxy.call).getCallSignatures()[0]?.getParameters().length : undefined;
            if (given === undefined) continue;
            for (const node of world.registered[on].get(activity) ?? []) {
              const needs = required(node);
              if (needs !== undefined && needs > given) wrong.push(`${activity} on the ${on} worker needs ${needs} arguments, and ${name} passes it ${given}`);
            }
          }
        }
      }
    }
    expect([...new Set(wrong)].sort()).toEqual([]);
  });
});

describe('what each role starts is what that role\'s workers run', () => {
  it('starts every workflow only in a role that runs the place it is started on', () => {
    const wrong = Object.entries(WORKFLOWS).flatMap(([name, { place, roles }]) => roles.filter((role) => !roleRuns(role, place)).map((role) => `${name} is started on ${role}, which runs no ${place} worker`));
    expect(wrong).toEqual([]);
  });

  it('has every activity a role\'s workflow calls registered by that role\'s worker of the queue it calls it on', () => {
    const forRole = (role: 'root' | 'instance', queue: string, activity: string): boolean =>
      world.registered[queue as keyof typeof world.registered].has(activity) && (queue !== 'host' || HOST_ACTIVITIES[role].includes(activity));
    const missing: string[] = [];
    for (const [name, { place, roles }] of Object.entries(WORKFLOWS)) {
      for (const role of roles) {
        if (role === 'hub') continue;
        for (const file of world.reachable(name)) {
          for (const proxy of world.proxies.get(file) ?? []) {
            if (proxy.queue === 'device') continue;
            const on = proxy.queue === 'own' ? place : proxy.queue;
            for (const activity of proxy.activities) if (!forRole(role, on, activity)) missing.push(`${name}, started on ${role}, calls ${activity} on the ${on} queue, which ${role}'s worker does not run`);
          }
        }
      }
    }
    expect([...new Set(missing)]).toEqual([]);
  });
});

describe('a workflow named by a string is one that exists', () => {
  const real = new Set(Object.keys(workflows));

  it('in Running and Failed work', () => {
    expect([...Object.keys(BY_TYPE), ...HIDDEN_TYPES, ...FAILURE_SHOWN_ON_RECORD].filter((type) => !real.has(type))).toEqual([]);
  });

  it('anywhere in the backend or the frontend', () => {
    const named = [SRC, FRONTEND].flatMap(sourceFiles).flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/['"`]([A-Z][A-Za-z]*Workflow)['"`]/g)].map((found) => ({ file: file.slice(SRC.length - 3), type: found[1]! })));
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((entry) => !real.has(entry.type)).map((entry) => `${entry.file}: ${entry.type}`)).toEqual([]);
  });
});

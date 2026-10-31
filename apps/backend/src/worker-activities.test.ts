import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';
import * as workflows from './workflows/index.js';
import { BY_TYPE, HIDDEN_TYPES } from './infrastructure/lib/running.js';
import { FAILURE_SHOWN_ON_RECORD } from './infrastructure/lib/work-failures.js';

const SRC = dirname(fileURLToPath(import.meta.url));
const FRONTEND = resolve(SRC, '../../frontend/src');

type Queue = 'host' | 'cluster' | 'engine' | 'stream';

const WORKERS: Record<Queue, string> = {
  host: 'worker-host.ts',
  cluster: 'worker-cluster.ts',
  engine: 'worker-engine.ts',
  stream: 'engine-host/temporal/stream-worker.ts',
};

const STARTED_ON: Record<keyof typeof workflows, Queue> = {
  ClusterProvisionWorkflow: 'host',
  executeDestroyClusterWorkflow: 'host',
  executeIngestWorkflow: 'host',
  DependencyWatchWorkflow: 'host',
  PoolInstanceWorkflow: 'host',
  PoolTrialWorkflow: 'host',
  PoolRemoveWorkflow: 'host',
  PoolMoveWorkflow: 'host',
  RootAccountRemovalWorkflow: 'host',
  RootNodeWorkflow: 'host',
  executeDeployAppWorkflow: 'cluster',
  executeDestroyAppWorkflow: 'cluster',
  executeResizeDiskWorkflow: 'cluster',
  executeSyncConfigWorkflow: 'cluster',
  executePipelineRunWorkflow: 'cluster',
  AgentRunWorkflow: 'engine',
  AdoptPlanWorkflow: 'engine',
  ConversationConclusionWorkflow: 'engine',
  BenchIdleWorkflow: 'engine',
  ConcludeWorkspaceWorkflow: 'engine',
  RemoveAccountWorkflow: 'engine',
  RemoveProjectWorkflow: 'engine',
  CheckRunWorkflow: 'engine',
};

interface Proxy {
  file: string;
  activities: string[];
  queue: Queue | 'device' | 'own';
}

let program: ts.Program;
let checker: ts.TypeChecker;
let registered: Record<Queue, Set<string>>;
let proxies: Map<string, Proxy[]>;
let imports: Map<string, string[]>;

function visit(node: ts.Node, found: (node: ts.Node) => void): void {
  found(node);
  ts.forEachChild(node, (child) => visit(child, found));
}

function sourceOf(path: string): ts.SourceFile {
  const file = program.getSourceFile(path);
  if (!file) throw new Error(`${path} is not in the program`);
  return file;
}

function propertyNames(type: ts.Type): string[] {
  return checker.getPropertiesOfType(checker.getApparentType(type)).map((symbol) => symbol.getName());
}

function activitiesOfWorker(path: string): Set<string> {
  const names = new Set<string>();
  visit(sourceOf(path), (node) => {
    if (!ts.isPropertyAssignment(node) || node.name.getText() !== 'activities') return;
    const created = node.parent.parent;
    if (!ts.isCallExpression(created) || !created.expression.getText().endsWith('Worker.create')) return;
    for (const name of propertyNames(checker.getTypeAtLocation(node.initializer))) names.add(name);
  });
  if (names.size === 0 && path.endsWith('worker-engine.ts')) {
    visit(sourceOf(path), (node) => {
      if (!ts.isShorthandPropertyAssignment(node) || node.name.getText() !== 'activities') return;
      const created = node.parent.parent;
      if (!ts.isCallExpression(created) || !created.expression.getText().endsWith('Worker.create')) return;
      for (const name of propertyNames(checker.getTypeAtLocation(node.name))) names.add(name);
    });
  }
  return names;
}

function queueOf(options: ts.Expression | undefined): Proxy['queue'] {
  if (!options || !ts.isObjectLiteralExpression(options)) return 'own';
  const named = options.properties.find((property) => property.name?.getText() === 'taskQueue');
  if (!named) return 'own';
  const text = ts.isPropertyAssignment(named) ? named.initializer.getText() : named.getText();
  if (text.includes('DEFAULT_STREAM_TASK_QUEUE')) return 'stream';
  if (text.includes('deviceQueue')) return 'device';
  throw new Error(`a proxy names the queue ${text}, which this test does not know`);
}

function proxiesIn(path: string): Proxy[] {
  const found: Proxy[] = [];
  visit(sourceOf(path), (node) => {
    if (!ts.isCallExpression(node) || node.expression.getText() !== 'proxyActivities') return;
    const typed = node.typeArguments?.[0];
    if (!typed) throw new Error(`${path}: proxyActivities without the activities' type`);
    found.push({ file: path, activities: propertyNames(checker.getTypeFromTypeNode(typed)), queue: queueOf(node.arguments[0]) });
  });
  return found;
}

function workflowImports(path: string): string[] {
  const out: string[] = [];
  for (const statement of sourceOf(path).statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly) continue;
    const spec = (statement.moduleSpecifier as ts.StringLiteral).text;
    if (!spec.startsWith('./')) continue;
    out.push(resolve(dirname(path), spec.replace(/\.js$/, '.ts')));
  }
  return out;
}

function reachable(path: string, seen = new Set<string>()): string[] {
  if (seen.has(path)) return [];
  seen.add(path);
  const others = new Set(Object.keys(STARTED_ON).map(fileOfWorkflow));
  return [path, ...(imports.get(path) ?? []).filter((next) => !others.has(next)).flatMap((next) => reachable(next, seen))];
}

function fileOfWorkflow(name: string): string {
  const index = readFileSync(join(SRC, 'workflows/index.ts'), 'utf8');
  const found = new RegExp(`export \\{ ${name} \\} from '\\./([A-Za-z-]+)\\.js'`).exec(index);
  if (!found) throw new Error(`${name} is not exported one per line from workflows/index.ts`);
  return join(SRC, 'workflows', `${found[1]}.ts`);
}

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
  checker = program.getTypeChecker();
  registered = Object.fromEntries(Object.entries(WORKERS).map(([queue, file]) => [queue, activitiesOfWorker(join(SRC, file))])) as Record<Queue, Set<string>>;
  proxies = new Map(workflowFiles.map((file) => [file, proxiesIn(file)]));
  imports = new Map(workflowFiles.map((file) => [file, workflowImports(file)]));
}, 300_000);

describe('what each workflow calls is what its worker runs', () => {
  it('knows which queue every workflow is started on', () => {
    expect(Object.keys(STARTED_ON).sort()).toEqual(Object.keys(workflows).sort());
  });

  it('finds every worker\'s activities', () => {
    for (const [queue, names] of Object.entries(registered)) expect(names.size, `${queue} worker`).toBeGreaterThan(0);
  });

  it('registers every activity a workflow can call on the worker of the queue it calls it on', () => {
    const missing: string[] = [];
    for (const [name, queue] of Object.entries(STARTED_ON)) {
      for (const file of reachable(fileOfWorkflow(name))) {
        for (const proxy of proxies.get(file) ?? []) {
          if (proxy.queue === 'device') continue;
          const on = proxy.queue === 'own' ? queue : proxy.queue;
          for (const activity of proxy.activities) {
            if (!registered[on].has(activity)) missing.push(`${name} (${file.slice(SRC.length + 1)}) calls ${activity} on the ${on} queue, whose worker does not run it`);
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
      [...readFileSync(file, 'utf8').matchAll(/['"`]([A-Za-z]+Workflow)['"`]/g)].map((found) => ({ file: file.slice(SRC.length - 3), type: found[1]! })));
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((entry) => !real.has(entry.type)).map((entry) => `${entry.file}: ${entry.type}`)).toEqual([]);
  });
});

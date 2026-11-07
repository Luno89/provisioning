import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';

export type Queue = 'host' | 'cluster' | 'engine' | 'stream';
export type ProxyQueue = Queue | 'device' | 'own';

export const WORKERS: Record<Queue, string> = {
  host: 'worker-host.ts',
  cluster: 'worker-cluster.ts',
  engine: 'worker-engine.ts',
  stream: 'engine-host/temporal/stream-worker.ts',
};

export const STARTED_ON: Record<string, Queue> = {
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
  StoredFilesWorkflow: 'engine',
  StoredFilesSweepWorkflow: 'engine',
};

export interface Proxy { file: string; call: ts.CallExpression; activities: string[]; queue: ProxyQueue }

export interface Proxied { activity: string; queues: Queue[]; device: boolean }

export interface TemporalWorld {
  registered: Record<Queue, Map<string, ts.Node[]>>;
  proxies: Map<string, Proxy[]>;
  reachable: (workflow: string) => string[];
  fileOfWorkflow: (workflow: string) => string;
  proxied: (call: ts.CallExpression) => Proxied | undefined;
  implementations: (proxied: Proxied) => ts.Node[];
  started: (call: ts.CallExpression) => ts.Node[] | undefined;
}

const STARTS = new Set(['start', 'execute', 'signalWithStart']);
const CHILD_STARTS = new Set(['executeChild', 'startChild']);

function visit(node: ts.Node, found: (node: ts.Node) => void): void {
  found(node);
  ts.forEachChild(node, (child) => visit(child, found));
}

function queueOf(options: ts.Expression | undefined): ProxyQueue {
  if (!options || !ts.isObjectLiteralExpression(options)) return 'own';
  const named = options.properties.find((property) => property.name?.getText() === 'taskQueue');
  if (!named) return 'own';
  const text = ts.isPropertyAssignment(named) ? named.initializer.getText() : named.getText();
  if (text.includes('DEFAULT_STREAM_TASK_QUEUE')) return 'stream';
  if (text.includes('deviceQueue')) return 'device';
  throw new Error(`a proxy names the queue ${text}, which the coupling harness does not know`);
}

const isProxyCall = (node: ts.Node | undefined): node is ts.CallExpression =>
  node !== undefined && ts.isCallExpression(node) && node.expression.getText() === 'proxyActivities';

export interface TemporalTables { workers: Partial<Record<Queue, string>>; startedOn: Record<string, Queue> }

export function temporalWorld(program: ts.Program, src: string, tables: TemporalTables = { workers: WORKERS, startedOn: STARTED_ON }): TemporalWorld {
  const checker = program.getTypeChecker();
  const sourceOf = (path: string): ts.SourceFile => {
    const file = program.getSourceFile(path);
    if (!file) throw new Error(`${path} is not in the program`);
    return file;
  };
  const activitiesOfWorker = (path: string): Map<string, ts.Node[]> => {
    const found = new Map<string, ts.Node[]>();
    visit(sourceOf(path), (node) => {
      if (!(ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) || node.name.getText() !== 'activities') return;
      const created = node.parent.parent;
      if (!ts.isCallExpression(created) || !created.expression.getText().endsWith('Worker.create')) return;
      const value = ts.isPropertyAssignment(node) ? node.initializer : node.name;
      for (const symbol of checker.getPropertiesOfType(checker.getApparentType(checker.getTypeAtLocation(value)))) {
        found.set(symbol.getName(), (symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol).getDeclarations() ?? []);
      }
    });
    return found;
  };

  const workflowFiles = program.getSourceFiles().map((source) => source.fileName).filter((file) => file.startsWith(join(src, 'workflows') + '/') && !file.endsWith('.test.ts'));
  const proxies = new Map<string, Proxy[]>();
  const imports = new Map<string, string[]>();
  for (const file of workflowFiles) {
    const found: Proxy[] = [];
    visit(sourceOf(file), (node) => {
      if (!isProxyCall(node)) return;
      const typed = node.typeArguments?.[0];
      if (!typed) throw new Error(`${file}: proxyActivities without the activities' type`);
      found.push({ file, call: node, activities: checker.getPropertiesOfType(checker.getApparentType(checker.getTypeFromTypeNode(typed))).map((symbol) => symbol.getName()), queue: queueOf(node.arguments[0]) });
    });
    proxies.set(file, found);
    imports.set(file, sourceOf(file).statements.flatMap((statement) => {
      if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly) return [];
      const spec = (statement.moduleSpecifier as ts.StringLiteral).text;
      return spec.startsWith('./') ? [resolve(dirname(file), spec.replace(/\.js$/, '.ts'))] : [];
    }));
  }

  const index = readFileSync(join(src, 'workflows/index.ts'), 'utf8');
  const fileOfWorkflow = (name: string): string => {
    const found = new RegExp(`export \\{ ${name} \\} from '\\./([A-Za-z-]+)\\.js'`).exec(index);
    if (!found) throw new Error(`${name} is not exported one per line from workflows/index.ts`);
    return join(src, 'workflows', `${found[1]}.ts`);
  };
  const starters = new Set(Object.keys(tables.startedOn).map(fileOfWorkflow));
  const reachableFrom = (path: string, seen = new Set<string>()): string[] => {
    if (seen.has(path)) return [];
    seen.add(path);
    return [path, ...(imports.get(path) ?? []).filter((next) => !starters.has(next)).flatMap((next) => reachableFrom(next, seen))];
  };
  const reachable = (workflow: string) => reachableFrom(fileOfWorkflow(workflow));

  const ownQueues = new Map<string, Set<Queue>>();
  for (const [workflow, queue] of Object.entries(tables.startedOn)) {
    for (const file of reachable(workflow)) ownQueues.set(file, new Set([...(ownQueues.get(file) ?? []), queue]));
  }

  const registered = Object.fromEntries((['host', 'cluster', 'engine', 'stream'] as const).map((queue) => [queue, tables.workers[queue] ? activitiesOfWorker(join(src, tables.workers[queue])) : new Map<string, ts.Node[]>()])) as Record<Queue, Map<string, ts.Node[]>>;

  const proxyOf = (name: ts.Expression): { proxy: ts.CallExpression; activity: string } | undefined => {
    if (ts.isIdentifier(name)) {
      const declaration = checker.getSymbolAtLocation(name)?.valueDeclaration;
      if (!declaration || !ts.isBindingElement(declaration)) return undefined;
      const holder = declaration.parent.parent;
      if (!ts.isVariableDeclaration(holder) || !isProxyCall(holder.initializer)) return undefined;
      return { proxy: holder.initializer, activity: (declaration.propertyName ?? declaration.name).getText() };
    }
    if (ts.isPropertyAccessExpression(name)) {
      const declaration = checker.getSymbolAtLocation(name.expression)?.valueDeclaration;
      if (!declaration || !ts.isVariableDeclaration(declaration) || !isProxyCall(declaration.initializer)) return undefined;
      return { proxy: declaration.initializer, activity: name.name.text };
    }
    return undefined;
  };

  return {
    registered,
    proxies,
    reachable,
    fileOfWorkflow,
    proxied: (call) => {
      const found = proxyOf(call.expression);
      if (!found) return undefined;
      const queue = queueOf(found.proxy.arguments[0]);
      if (queue === 'device') return { activity: found.activity, queues: [], device: true };
      const queues = queue === 'own' ? [...(ownQueues.get(found.proxy.getSourceFile().fileName) ?? [])] : [queue];
      return { activity: found.activity, queues, device: false };
    },
    implementations: (proxied) => proxied.queues.flatMap((queue) => registered[queue].get(proxied.activity) ?? []),
    started: (call) => {
      const callee = call.expression;
      const method = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : undefined;
      if (!method || !(STARTS.has(method) || CHILD_STARTS.has(method))) return undefined;
      const declared = checker.getResolvedSignature(call)?.getDeclaration()?.getSourceFile().fileName ?? '';
      const fromTemporal = STARTS.has(method) ? declared.includes('/@temporalio/client/') : declared.includes('/@temporalio/workflow/');
      if (!fromTemporal) return undefined;
      const first = call.arguments[0];
      return first ? workflowsNamedBy(first) : [];
    },
  };

  function workflowsNamedBy(expression: ts.Expression): ts.Node[] {
    const type = checker.getTypeAtLocation(expression);
    if (type.isStringLiteral()) return workflowFunction(type.value);
    if (type.isUnion() && type.types.every((part) => part.isStringLiteral())) return type.types.flatMap((part) => (part.isStringLiteral() ? workflowFunction(part.value) : []));
    const symbol = checker.getSymbolAtLocation(expression);
    const declaration = (symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol)?.valueDeclaration;
    if (declaration && (ts.isFunctionDeclaration(declaration) || ts.isVariableDeclaration(declaration))) return [declaration];
    return [];
  }

  function workflowFunction(name: string): ts.Node[] {
    if (!new RegExp(`export \\{ ${name} \\} from`).test(index)) return [];
    const found: ts.Node[] = [];
    visit(sourceOf(fileOfWorkflow(name)), (node) => {
      if ((ts.isFunctionDeclaration(node) && node.name?.text === name) || (ts.isVariableDeclaration(node) && node.name.getText() === name)) found.push(node);
    });
    return found;
  }
}

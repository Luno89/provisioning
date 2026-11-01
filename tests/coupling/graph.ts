import { relative } from 'node:path';
import ts from 'typescript';

export interface Unit {
  id: string;
  file: string;
  name: string;
  line: number;
  column: number;
  start: number;
  end: number;
  inTest: boolean;
}

export interface Site { file: string; line: number; column: number; start: number; end: number }

export interface Edge {
  from: string;
  site: Site;
  to: string[];
  through: 'call' | 'interface' | 'temporal';
  device?: boolean;
}

export interface Unresolved { from: string; site: Site; text: string; why: string }

export interface Graph {
  units: Record<string, Unit>;
  edges: Edge[];
  unresolved: Unresolved[];
}

export interface CrossProcess { to: ts.Node[]; through: 'temporal'; device?: boolean }

export interface Project {
  tsconfig: string;
  owns: (file: string) => boolean;
  crossing?: (program: ts.Program) => (call: ts.CallExpression) => CrossProcess | undefined;
}

export interface GraphOptions {
  projects: readonly Project[];
  root: string;
  calledFrom: (file: string) => boolean;
}

const TEST_FOLDER = /(^|\/)(tests?|testing|__tests__)\//;
const TEST_FILE = /\.test\.tsx?$|(^|\/)(test-[^/]*|fake-[^/]*|[^/]*-fakes?|[^/]*\.fake)\.tsx?$/;

export const isTest = (file: string): boolean => TEST_FILE.test(file) || TEST_FOLDER.test(file);

const GENERATED = /\.generated\.ts$/;

const ownCode = (file: string): boolean => !file.includes('/node_modules/') && !file.endsWith('.d.ts');

function functionName(node: ts.Node): string {
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node)) && node.name) {
    const owner = node.parent && (ts.isClassDeclaration(node.parent) || ts.isClassExpression(node.parent)) && node.parent.name ? `${node.parent.name.text}.` : '';
    return `${owner}${node.name.getText()}`;
  }
  if (ts.isConstructorDeclaration(node)) return `${node.parent.name?.text ?? 'class'}.constructor`;
  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent)) return parent.name.getText();
  if (parent && ts.isPropertyAssignment(parent)) return parent.name.getText();
  if (parent && ts.isPropertyDeclaration(parent)) return parent.name.getText();
  return '(anonymous)';
}

const FUNCTION_KINDS = new Set([
  ts.SyntaxKind.FunctionDeclaration, ts.SyntaxKind.MethodDeclaration, ts.SyntaxKind.ArrowFunction, ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.Constructor, ts.SyntaxKind.GetAccessor, ts.SyntaxKind.SetAccessor,
]);

const isMember = (node: ts.Node): boolean => ts.isMethodSignature(node) || ts.isPropertySignature(node);

export function buildGraph(options: GraphOptions): Graph {
  const units: Record<string, Unit> = {};
  const edges: Edge[] = [];
  const unresolved: Unresolved[] = [];
  const at = (file: string) => relative(options.root, file);

  const unitOf = (node: ts.Node): Unit => {
    const source = node.getSourceFile();
    const file = at(source.fileName);
    const start = node.getStart(source);
    const { line, character } = source.getLineAndCharacterOfPosition(start);
    const id = `${file}:${line + 1}:${character + 1}`;
    units[id] ??= { id, file, name: functionName(node), line: line + 1, column: character + 1, start, end: node.getEnd(), inTest: isTest(file) };
    return units[id];
  };

  const moduleUnit = (source: ts.SourceFile): Unit => {
    const file = at(source.fileName);
    const id = `${file}:module`;
    units[id] ??= { id, file, name: '(module)', line: 1, column: 1, start: 0, end: source.getEnd(), inTest: isTest(file) };
    return units[id];
  };

  const enclosing = (node: ts.Node): Unit => {
    for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) if (FUNCTION_KINDS.has(parent.kind)) return unitOf(parent);
    return moduleUnit(node.getSourceFile());
  };

  const siteOf = (node: ts.Node): Site => {
    const source = node.getSourceFile();
    const start = node.getStart(source);
    const { line, character } = source.getLineAndCharacterOfPosition(start);
    return { file: at(source.fileName), line: line + 1, column: character + 1, start, end: node.getEnd() };
  };

  const seenSites = new Set<string>();

  for (const project of options.projects) {
    const config = ts.getParsedCommandLineOfConfigFile(project.tsconfig, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (problem) => { throw new Error(String(problem.messageText)); } });
    if (!config) throw new Error(`${project.tsconfig} could not be read`);
    const program = ts.createProgram(config.fileNames, { ...config.options, noEmit: true });
    const checker = program.getTypeChecker();
    const sources = program.getSourceFiles().filter((source) => ownCode(source.fileName));
    const crossing = project.crossing?.(program);

    const aliased = (symbol: ts.Symbol | undefined): ts.Symbol | undefined => (symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol);
    const functionOf = (node: ts.Node | undefined, depth = 0): ts.Node | undefined => {
      if (!node || depth > 4) return undefined;
      if (FUNCTION_KINDS.has(node.kind)) return node;
      if (ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node) || ts.isVariableDeclaration(node)) return functionOf(node.initializer, depth + 1);
      if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) return functionOf(node.expression, depth + 1);
      if (ts.isShorthandPropertyAssignment(node)) return functionOf(aliased(checker.getShorthandAssignmentValueSymbol(node))?.valueDeclaration, depth + 1);
      if (ts.isIdentifier(node)) return functionOf(aliased(checker.getSymbolAtLocation(node))?.valueDeclaration, depth + 1);
      if (ts.isPropertyAccessExpression(node)) return functionOf(checker.getSymbolAtLocation(node.name)?.valueDeclaration, depth + 1);
      return undefined;
    };

    const implementations = new Map<ts.Node, Set<ts.Node>>();
    const implement = (member: ts.Node, body: ts.Node) => {
      const known = implementations.get(member) ?? new Set<ts.Node>();
      known.add(body);
      implementations.set(member, known);
    };
    const implementationsOf = (member: ts.Node, seen = new Set<ts.Node>()): ts.Node[] => {
      if (seen.has(member)) return [];
      seen.add(member);
      return [...(implementations.get(member) ?? [])].flatMap((body) => (isMember(body) ? implementationsOf(body, seen) : [body]));
    };
    const ownMembers = new Map<ts.Type, Array<[string, ts.Node[]]>>();
    const membersWanted = (type: ts.Type): Array<[string, ts.Node[]]> => {
      const known = ownMembers.get(type);
      if (known) return known;
      const found: Array<[string, ts.Node[]]> = [];
      for (const property of type.getNonNullableType().getProperties()) {
        const members = (property.getDeclarations() ?? []).filter((declaration) => isMember(declaration) && ownCode(declaration.getSourceFile().fileName));
        if (members.length > 0) found.push([property.getName(), members]);
      }
      ownMembers.set(type, found);
      return found;
    };
    const matched = new Map<ts.Type, Set<ts.Type>>();
    const typeOf = (symbol: ts.Symbol, near: ts.Node): ts.Type => checker.getTypeOfSymbolAtLocation(symbol, near).getNonNullableType();
    const matchTypes = (target: ts.Type, actual: ts.Type, near: ts.Node, depth = 0) => {
      if (depth > 3 || target === actual) return;
      const pairs = matched.get(target) ?? new Set<ts.Type>();
      if (pairs.has(actual)) return;
      pairs.add(actual);
      matched.set(target, pairs);
      for (const [name, members] of membersWanted(target)) {
        const property = actual.getProperty(name);
        if (!property) continue;
        for (const declaration of property.getDeclarations() ?? []) {
          const body = isMember(declaration) ? declaration : functionOf(declaration);
          if (body && !members.includes(body)) for (const member of members) implement(member, body);
        }
        const wanted = target.getProperty(name);
        if (!wanted) continue;
        const inner = typeOf(wanted, near);
        const given = typeOf(property, near);
        if (inner.getCallSignatures().length > 0) {
          callsInto(inner, given, (property.getDeclarations() ?? []).map((declaration) => functionOf(declaration)).find(Boolean));
          continue;
        }
        if (membersWanted(inner).length === 0) continue;
        matchTypes(inner, given, near, depth + 1);
      }
    };
    const callsInto = (target: ts.Type, actual: ts.Type, body: ts.Node | undefined) => {
      const signatures = target.getCallSignatures().map((signature) => signature.getDeclaration()).filter((declaration) => declaration && ts.isCallSignatureDeclaration(declaration) && ownCode(declaration.getSourceFile().fileName));
      if (signatures.length === 0) return;
      const made = body ?? actual.getCallSignatures().map((signature) => signature.getDeclaration()).find((declaration) => declaration && (FUNCTION_KINDS.has(declaration.kind) || ts.isCallSignatureDeclaration(declaration)));
      if (made) for (const signature of signatures) implement(signature, made);
    };
    const handedTo = (target: ts.Type | undefined, value: ts.Node) => {
      if (!target) return;
      const wanted = target.getNonNullableType();
      const actual = checker.getTypeAtLocation(value).getNonNullableType();
      callsInto(wanted, actual, functionOf(value));
      if (membersWanted(wanted).length === 0) return;
      matchTypes(wanted, actual, value);
    };
    const classInto = (target: ts.Type, made: ts.ClassLikeDeclaration) => {
      const symbol = made.name ? checker.getSymbolAtLocation(made.name) : undefined;
      if (symbol) matchTypes(target.getNonNullableType(), checker.getDeclaredTypeOfSymbol(symbol), made);
    };

    for (const source of sources) {
      const index = (node: ts.Node) => {
        if ((ts.isClassDeclaration(node) || ts.isClassExpression(node)) && node.heritageClauses) {
          for (const clause of node.heritageClauses) for (const type of clause.types) classInto(checker.getTypeAtLocation(type), node);
        }
        if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
          for (const argument of node.arguments ?? []) handedTo(checker.getContextualType(argument), argument);
        } else if ((ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isPropertyAssignment(node)) && node.initializer) {
          handedTo(checker.getContextualType(node.initializer), node.initializer);
        } else if (ts.isShorthandPropertyAssignment(node) && ts.isObjectLiteralExpression(node.parent)) {
          const owner = checker.getContextualType(node.parent);
          const property = owner?.getNonNullableType().getProperty(node.name.text);
          if (property) handedTo(checker.getTypeOfSymbolAtLocation(property, node), node.name);
        } else if (ts.isReturnStatement(node) && node.expression) {
          handedTo(checker.getContextualType(node.expression), node.expression);
        } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          handedTo(checker.getTypeAtLocation(node.left), node.right);
        } else if (ts.isSatisfiesExpression(node) || ts.isAsExpression(node)) {
          handedTo(checker.getTypeAtLocation(node.type), node.expression);
        } else if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) {
          handedTo(checker.getContextualType(node.body), node.body);
        }
        ts.forEachChild(node, index);
      };
      index(source);
    }

    for (const source of sources) {
      const file = at(source.fileName);
      if (!project.owns(file) || !options.calledFrom(file)) continue;
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
          const site = siteOf(node);
          const key = `${site.file}:${site.start}`;
          if (!seenSites.has(key)) {
            seenSites.add(key);
            const from = enclosing(node);
            const crossed = crossing && ts.isCallExpression(node) ? crossing(node) : undefined;
            const declaration = crossed ? undefined : checker.getResolvedSignature(node)?.getDeclaration() as ts.Declaration | undefined;
            if (crossed) {
              const to = crossed.to.flatMap((declared) => (isMember(declared) ? implementationsOf(declared) : [functionOf(declared)])).filter((body): body is ts.Node => body !== undefined).map(unitOf).filter((unit) => !unit.inTest);
              edges.push({ from: from.id, site, to: [...new Set(to.map((unit) => unit.id))], through: crossed.through, ...(crossed.device ? { device: true } : {}) });
            } else if (!declaration) {
              const type = checker.getTypeAtLocation(node.expression);
              if (type.flags & ts.TypeFlags.Any) unresolved.push({ from: from.id, site, text: node.expression.getText().slice(0, 80), why: 'called through any' });
            } else if (ownCode(declaration.getSourceFile().fileName) && !GENERATED.test(declaration.getSourceFile().fileName)) {
              const target = at(declaration.getSourceFile().fileName);
              if (FUNCTION_KINDS.has(declaration.kind)) {
                if (target !== from.file) edges.push({ from: from.id, site, to: [unitOf(declaration).id], through: 'call' });
              } else if (isMember(declaration) || ts.isCallSignatureDeclaration(declaration)) {
                const real = implementationsOf(declaration).map(unitOf).filter((unit) => !unit.inTest);
                const elsewhere = real.filter((unit) => unit.file !== from.file);
                if (real.length === 0 || elsewhere.length > 0) edges.push({ from: from.id, site, to: elsewhere.map((unit) => unit.id), through: 'interface' });
              } else if (ts.isVariableDeclaration(declaration)) {
                const body = functionOf(declaration);
                if (body && target !== from.file) edges.push({ from: from.id, site, to: [unitOf(body).id], through: 'call' });
              }
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
  return { units, edges, unresolved };
}

import { relative } from 'node:path';
import ts from 'typescript';
import type { RecordAccess } from './record-access.js';

export interface Unit {
  id: string;
  file: string;
  name: string;
  line: number;
  column: number;
  start: number;
  end: number;
  ends?: { line: number; column: number } | undefined;
  inTest: boolean;
}

export interface Site { file: string; line: number; column: number; start: number; end: number }

export interface Edge {
  from: string;
  site: Site;
  to: string[];
  through: 'call' | 'interface' | 'temporal' | 'render' | 'reference' | ChannelEnd['kind'];
  device?: boolean;
}

export interface Unresolved { from: string; site: Site; text: string; why: string }

export interface ExtraEnd { unit: { file: string; line: number; name: string }; kind: ChannelEnd['kind']; name: string; side: ChannelEnd['side'] }

export interface Unmatched { kind: ChannelEnd['kind']; name: string; side: ChannelEnd['side']; site: Site }

export interface RecordTouch { unit: string; collection: string; writes: boolean; site: Site }

export interface Graph {
  units: Record<string, Unit>;
  edges: Edge[];
  unresolved: Unresolved[];
  unmatched: Unmatched[];
  records: RecordTouch[];
}

export interface CrossProcess { to: ts.Node[]; through: 'temporal'; device?: boolean; alsoCalls?: boolean }

export interface ChannelEnd { kind: 'socket' | 'http' | 'env'; name: string; side: 'sends' | 'hears'; handler?: ts.Node }

export interface Project {
  tsconfig: string;
  owns: (file: string) => boolean;
  crossing?: (program: ts.Program) => (call: ts.CallExpression) => CrossProcess | undefined;
  channels?: (program: ts.Program) => (call: ts.CallExpression) => ChannelEnd[] | undefined;
  readers?: (program: ts.Program) => (node: ts.Node) => ChannelEnd[] | undefined;
  records?: (program: ts.Program) => (call: ts.CallExpression) => RecordAccess[];
}

export interface GraphOptions {
  projects: readonly Project[];
  root: string;
  calledFrom: (file: string) => boolean;
  matches?: Partial<Record<ChannelEnd['kind'], (sent: string, heard: string) => boolean>>;
  extraEnds?: readonly ExtraEnd[];
  withinFiles?: boolean;
  handOffs?: boolean;
}

const TEST_FOLDER = /(^|\/)(tests?|testing|__tests__)\//;
const TEST_FILE = /\.test\.tsx?$|(^|\/)(test-[^/]*|fake-[^/]*|[^/]*-fakes?|[^/]*\.fake)\.tsx?$/;

export const isTestFile = (file: string): boolean => TEST_FILE.test(file);

export const isTest = (file: string): boolean => isTestFile(file) || TEST_FOLDER.test(file);

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

const declaringMember = (node: ts.Declaration | undefined): ts.Declaration | undefined => {
  if (!node || !ts.isFunctionTypeNode(node)) return node;
  let at: ts.Node = node.parent;
  while (ts.isParenthesizedTypeNode(at) || ts.isUnionTypeNode(at)) at = at.parent;
  return isMember(at) ? at as ts.Declaration : node;
};

export function buildGraph(options: GraphOptions): Graph {
  const units: Record<string, Unit> = {};
  const edges: Edge[] = [];
  const unresolved: Unresolved[] = [];
  const records: RecordTouch[] = [];
  const at = (file: string) => relative(options.root, file);

  const unitOf = (node: ts.Node): Unit => {
    const source = node.getSourceFile();
    const file = at(source.fileName);
    const start = node.getStart(source);
    const { line, character } = source.getLineAndCharacterOfPosition(start);
    const id = `${file}:${line + 1}:${character + 1}`;
    const last = source.getLineAndCharacterOfPosition(node.getEnd());
    units[id] ??= { id, file, name: functionName(node), line: line + 1, column: character + 1, start, end: node.getEnd(), ends: { line: last.line + 1, column: last.character + 1 }, inTest: isTest(file) };
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
  const ends: Array<{ kind: ChannelEnd['kind']; name: string; side: ChannelEnd['side']; from: string; site: Site; handler?: string }> = [];

  for (const project of options.projects) {
    const config = ts.getParsedCommandLineOfConfigFile(project.tsconfig, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (problem) => { throw new Error(String(problem.messageText)); } });
    if (!config) throw new Error(`${project.tsconfig} could not be read`);
    const program = ts.createProgram(config.fileNames, { ...config.options, noEmit: true });
    const checker = program.getTypeChecker();
    const sources = program.getSourceFiles().filter((source) => ownCode(source.fileName));
    const crossing = project.crossing?.(program);
    const channels = project.channels?.(program);
    const readers = project.readers?.(program);
    const recordOf = project.records?.(program);

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
    const implementedOutside = new Set<ts.Node>();
    const implement = (member: ts.Node, body: ts.Node) => {
      if (!ownCode(body.getSourceFile().fileName)) {
        implementedOutside.add(member);
        return;
      }
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
    const handedTo = (target: ts.Type | undefined, value: ts.Node): void => {
      if (!target) return;
      const wanted = target.getNonNullableType();
      if (wanted.isUnion()) {
        for (const part of wanted.types) handedTo(part, value);
        return;
      }
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

    const renderedComponent = (tag: ts.JsxTagNameExpression): ts.Node | undefined => {
      if (ts.isIdentifier(tag) && /^[a-z]/.test(tag.text)) return undefined;
      const named = checker.getSymbolAtLocation(tag);
      const symbol = named && named.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(named) : named;
      const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
      if (!declaration || !ownCode(declaration.getSourceFile().fileName)) return undefined;
      return FUNCTION_KINDS.has(declaration.kind) ? declaration : functionOf(declaration);
    };

    const handedFunction = (name: ts.Identifier): ts.Node | undefined => {
      const value = ts.isPropertyAccessExpression(name.parent) && name.parent.name === name ? name.parent : name;
      const parent = value.parent;
      if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === value) return undefined;
      if (ts.isPropertyAccessExpression(parent) && parent.expression === value) return undefined;
      if (ts.isJsxOpeningElement(parent) || ts.isJsxSelfClosingElement(parent) || ts.isJsxClosingElement(parent)) return undefined;
      if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isExportSpecifier(parent) || ts.isNamespaceImport(parent)) return undefined;
      if (ts.isTypeReferenceNode(parent) || ts.isTypeQueryNode(parent) || ts.isQualifiedName(parent)) return undefined;
      const named = checker.getSymbolAtLocation(name);
      const symbol = named && named.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(named) : named;
      const declaration = symbol?.valueDeclaration;
      if (!declaration || ts.getNameOfDeclaration(declaration) === name) return undefined;
      if (!ownCode(declaration.getSourceFile().fileName) || GENERATED.test(declaration.getSourceFile().fileName)) return undefined;
      if (FUNCTION_KINDS.has(declaration.kind)) return declaration;
      return ts.isVariableDeclaration(declaration) ? functionOf(declaration) : undefined;
    };

    for (const source of sources) {
      const file = at(source.fileName);
      if (!project.owns(file) || !options.calledFrom(file)) continue;
      const visit = (node: ts.Node) => {
        for (const end of readers?.(node) ?? []) {
          const site = siteOf(node);
          ends.push({ kind: end.kind, name: end.name, side: end.side, from: enclosing(node).id, site });
        }
        if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
          const site = siteOf(node);
          const key = `${site.file}:${site.start}:${site.end}`;
          if (!seenSites.has(key)) {
            seenSites.add(key);
            const from = enclosing(node);
            for (const end of (channels && ts.isCallExpression(node) ? channels(node) : undefined) ?? []) {
              const handler = end.handler ? functionOf(end.handler) : undefined;
              ends.push({ kind: end.kind, name: end.name, side: end.side, from: from.id, site, ...(handler ? { handler: unitOf(handler).id } : {}) });
            }
            for (const touched of recordOf && ts.isCallExpression(node) ? recordOf(node) : []) records.push({ unit: from.id, collection: touched.collection, writes: touched.writes, site });
            const crossed = crossing && ts.isCallExpression(node) ? crossing(node) : undefined;
            if (crossed) {
              const to = crossed.to.flatMap((declared) => (isMember(declared) ? implementationsOf(declared) : [functionOf(declared)])).filter((body): body is ts.Node => body !== undefined).map(unitOf).filter((unit) => !unit.inTest);
              edges.push({ from: from.id, site, to: [...new Set(to.map((unit) => unit.id))], through: crossed.through, ...(crossed.device ? { device: true } : {}) });
            }
            const declaration = crossed && !crossed.alsoCalls ? undefined : declaringMember(checker.getResolvedSignature(node)?.getDeclaration() as ts.Declaration | undefined);
            if (!crossed && !declaration) {
              const type = checker.getTypeAtLocation(node.expression);
              if (type.flags & ts.TypeFlags.Any) unresolved.push({ from: from.id, site, text: node.expression.getText().slice(0, 80), why: 'called through any' });
            } else if (declaration && ownCode(declaration.getSourceFile().fileName) && !GENERATED.test(declaration.getSourceFile().fileName)) {
              const target = at(declaration.getSourceFile().fileName);
              const counted = (file: string) => options.withinFiles || file !== from.file;
              if (FUNCTION_KINDS.has(declaration.kind)) {
                if (counted(target)) edges.push({ from: from.id, site, to: [unitOf(declaration).id], through: 'call' });
              } else if (isMember(declaration) || ts.isCallSignatureDeclaration(declaration)) {
                const real = implementationsOf(declaration).map(unitOf).filter((unit) => !unit.inTest);
                const elsewhere = real.filter((unit) => counted(unit.file));
                if ((real.length === 0 && !implementedOutside.has(declaration)) || elsewhere.length > 0) edges.push({ from: from.id, site, to: elsewhere.map((unit) => unit.id), through: 'interface' });
              } else if (ts.isVariableDeclaration(declaration)) {
                const body = functionOf(declaration);
                if (body && counted(target)) edges.push({ from: from.id, site, to: [unitOf(body).id], through: 'call' });
              }
            }
          }
        }
        if (options.handOffs && (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))) {
          const rendered = renderedComponent(node.tagName);
          if (rendered) edges.push({ from: enclosing(node).id, site: siteOf(node), to: [unitOf(rendered).id], through: 'render' });
        }
        if (options.handOffs && ts.isIdentifier(node)) {
          const handed = handedFunction(node);
          const from = handed ? enclosing(node) : undefined;
          const to = handed ? unitOf(handed) : undefined;
          if (from && to && from.id !== to.id && !to.inTest) edges.push({ from: from.id, site: siteOf(node), to: [to.id], through: 'reference' });
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
  for (const extra of options.extraEnds ?? []) {
    const id = `${extra.unit.file}:${extra.unit.line}:1`;
    units[id] ??= { id, file: extra.unit.file, name: extra.unit.name, line: extra.unit.line, column: 1, start: 0, end: 0, inTest: false };
    ends.push({ kind: extra.kind, name: extra.name, side: extra.side, from: id, site: { file: extra.unit.file, line: extra.unit.line, column: 1, start: 0, end: 0 } });
  }
  const unmatched: Unmatched[] = [];
  const byKind = new Map<string, typeof ends>();
  for (const end of ends) byKind.set(end.kind, [...(byKind.get(end.kind) ?? []), end]);
  for (const end of ends) {
    const match = options.matches?.[end.kind] ?? ((sent: string, heard: string) => sent === heard);
    const partners = (byKind.get(end.kind) ?? []).filter((other) => other.side !== end.side && (end.side === 'sends' ? match(end.name, other.name) : match(other.name, end.name)));
    if (partners.length === 0) unmatched.push({ kind: end.kind, name: end.name, side: end.side, site: end.site });
    if (end.side !== 'sends' || partners.length === 0) continue;
    const to = [...new Set(partners.map((partner) => partner.handler ?? partner.from))];
    edges.push({ from: end.from, site: end.site, to, through: end.kind });
  }
  return { units, edges, unresolved, unmatched, records };
}

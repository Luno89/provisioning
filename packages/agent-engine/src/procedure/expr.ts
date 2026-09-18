export type ExprValue = string | number | boolean | null | undefined | unknown[] | Record<string, unknown>;

type Token =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'ident'; v: string }
  | { t: 'op'; v: string }
  | { t: 'lparen' }
  | { t: 'rparen' }
  | { t: 'comma' }
  | { t: 'end' };

export class ExprError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExprError';
  }
}

const OPERATORS = ['==', '!=', '>=', '<=', '>', '<'];
const WORD_OPERATORS = new Set(['and', 'or', 'not', 'true', 'false', 'null']);
export const FUNCTIONS = new Set(['len', 'empty', 'contains', 'startsWith', 'endsWith', 'matches']);

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    const ch = input[i]!;

    if (/\s/.test(ch)) { i += 1; continue; }

    if (ch === '(') { tokens.push({ t: 'lparen' }); i += 1; continue; }
    if (ch === ')') { tokens.push({ t: 'rparen' }); i += 1; continue; }
    if (ch === ',') { tokens.push({ t: 'comma' }); i += 1; continue; }

    if (ch === '"' || ch === "'") {
      const quote = ch;
      let value = '';
      i += 1;
      while (i < input.length && input[i] !== quote) {
        if (input[i] === '\\' && i + 1 < input.length) {
          value += input[i + 1];
          i += 2;
          continue;
        }
        value += input[i];
        i += 1;
      }
      if (i >= input.length) throw new ExprError(`unterminated string starting at position ${i}`);
      i += 1;
      tokens.push({ t: 'str', v: value });
      continue;
    }

    if (/[0-9]/.test(ch)) {
      let raw = '';
      while (i < input.length && /[0-9._]/.test(input[i]!)) {
        raw += input[i];
        i += 1;
      }
      const value = Number(raw.replace(/_/g, ''));
      if (Number.isNaN(value)) throw new ExprError(`"${raw}" is not a number`);
      tokens.push({ t: 'num', v: value });
      continue;
    }

    const twoChar = input.slice(i, i + 2);
    if (OPERATORS.includes(twoChar)) { tokens.push({ t: 'op', v: twoChar }); i += 2; continue; }
    if (OPERATORS.includes(ch)) { tokens.push({ t: 'op', v: ch }); i += 1; continue; }

    if (/[A-Za-z_]/.test(ch)) {
      let raw = '';
      while (i < input.length && /[A-Za-z0-9_.]/.test(input[i]!)) {
        raw += input[i];
        i += 1;
      }
      tokens.push({ t: 'ident', v: raw });
      continue;
    }

    throw new ExprError(`unexpected character "${ch}" at position ${i}`);
  }

  tokens.push({ t: 'end' });
  return tokens;
}

function truthy(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function readPath(scope: unknown, path: string): unknown {
  let current: unknown = scope;
  for (const segment of path.split('.')) {
    if (current === undefined || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function callFunction(name: string, args: unknown[]): unknown {
  const [first, second] = args;

  if (name === 'len') {
    if (typeof first === 'string' || Array.isArray(first)) return first.length;
    return 0;
  }
  if (name === 'empty') {
    if (first === undefined || first === null) return true;
    if (typeof first === 'string' || Array.isArray(first)) return first.length === 0;
    return false;
  }
  if (name === 'contains') {
    if (typeof first === 'string') return first.includes(String(second));
    if (Array.isArray(first)) return first.some((entry) => entry === second);
    return false;
  }
  if (name === 'startsWith') return typeof first === 'string' && first.startsWith(String(second));
  if (name === 'endsWith') return typeof first === 'string' && first.endsWith(String(second));
  if (name === 'matches') {
    if (typeof first !== 'string') return false;
    try {
      return new RegExp(String(second)).test(first);
    } catch {
      throw new ExprError(`matches() was given an invalid pattern: ${String(second)}`);
    }
  }

  throw new ExprError(`no function named "${name}"`);
}

const nullish = (value: unknown): boolean => value === null || value === undefined;

function compare(op: string, left: unknown, right: unknown): boolean {
  if (op === '==') return nullish(left) && nullish(right) ? true : left === right;
  if (op === '!=') return nullish(left) && nullish(right) ? false : left !== right;

  const l = typeof left === 'number' ? left : Number(left);
  const r = typeof right === 'number' ? right : Number(right);
  if (Number.isNaN(l) || Number.isNaN(r)) return false;

  if (op === '>') return l > r;
  if (op === '>=') return l >= r;
  if (op === '<') return l < r;
  if (op === '<=') return l <= r;

  throw new ExprError(`unknown operator "${op}"`);
}

export interface CompiledExpr {
  source: string;
  evaluate(scope: Record<string, unknown>): boolean;
}

export function compileExpr(source: string): CompiledExpr {
  const tokens = tokenize(source);
  let pos = 0;

  const peek = (): Token => tokens[pos]!;
  const next = (): Token => tokens[pos++]!;

  type Node = (scope: Record<string, unknown>) => unknown;

  const parsePrimary = (): Node => {
    const token = next();

    if (token.t === 'lparen') {
      const inner = parseOr();
      if (peek().t !== 'rparen') throw new ExprError('missing closing parenthesis');
      next();
      return inner;
    }

    if (token.t === 'num') return () => token.v;
    if (token.t === 'str') return () => token.v;

    if (token.t === 'ident') {
      if (token.v === 'true') return () => true;
      if (token.v === 'false') return () => false;
      if (token.v === 'null') return () => null;

      if (peek().t === 'lparen') {
        if (!FUNCTIONS.has(token.v)) throw new ExprError(`no function named "${token.v}"`);
        next();
        const args: Node[] = [];
        while (peek().t !== 'rparen') {
          args.push(parseOr());
          if (peek().t === 'comma') next();
          else break;
        }
        if (peek().t !== 'rparen') throw new ExprError(`missing closing parenthesis after ${token.v}(`);
        next();
        return (scope) => callFunction(token.v, args.map((arg) => arg(scope)));
      }

      return (scope) => readPath(scope, token.v);
    }

    throw new ExprError(`unexpected token in expression: ${JSON.stringify(token)}`);
  };

  const parseNot = (): Node => {
    if (peek().t === 'ident' && (peek() as { v: string }).v === 'not') {
      next();
      const operand = parseNot();
      return (scope) => !truthy(operand(scope));
    }
    return parsePrimary();
  };

  const parseComparison = (): Node => {
    const left = parseNot();
    const token = peek();
    if (token.t === 'op') {
      next();
      const right = parseNot();
      return (scope) => compare(token.v, left(scope), right(scope));
    }
    return left;
  };

  const parseAnd = (): Node => {
    let left = parseComparison();
    while (peek().t === 'ident' && (peek() as { v: string }).v === 'and') {
      next();
      const right = parseComparison();
      const prev = left;
      left = (scope) => truthy(prev(scope)) && truthy(right(scope));
    }
    return left;
  };

  function parseOr(): Node {
    let left = parseAnd();
    while (peek().t === 'ident' && (peek() as { v: string }).v === 'or') {
      next();
      const right = parseAnd();
      const prev = left;
      left = (scope) => truthy(prev(scope)) || truthy(right(scope));
    }
    return left;
  }

  const root = parseOr();
  if (peek().t !== 'end') throw new ExprError(`unexpected trailing input in "${source}"`);

  return {
    source,
    evaluate(scope: Record<string, unknown>): boolean {
      return truthy(root(scope));
    },
  };
}

export function referencedPaths(source: string): string[] {
  const paths = new Set<string>();
  const tokens = tokenize(source);

  tokens.forEach((token, index) => {
    if (token.t !== 'ident') return;
    if (WORD_OPERATORS.has(token.v)) return;
    if (tokens[index + 1]?.t === 'lparen') return;
    paths.add(token.v);
  });

  return [...paths];
}

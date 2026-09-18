const WHOLE = /^\s*\{\{\s*([\w.]+)\s*\}\}\s*$/;
const ANY = /\{\{\s*([\w.]+)\s*\}\}/g;

export class MissingValue extends Error {
  readonly path: string;

  constructor(path: string, where: string) {
    super(`${where} needs ${path}, which this run was not given`);
    this.name = 'MissingValue';
    this.path = path;
  }
}

function readPath(scope: Readonly<Record<string, unknown>>, path: string): unknown {
  let found: unknown = scope;
  for (const step of path.split('.')) {
    if (found === undefined || found === null || typeof found !== 'object') return undefined;
    found = (found as Record<string, unknown>)[step];
  }
  return found;
}

export function fillTemplate(
  args: Record<string, unknown> | undefined,
  scope: Readonly<Record<string, unknown>>,
  where: string,
): Record<string, unknown> {
  const need = (path: string): unknown => {
    const found = readPath(scope, path);
    if (found === undefined || found === null) throw new MissingValue(path, where);
    return found;
  };

  const resolve = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const whole = WHOLE.exec(value);
      if (whole) return need(whole[1]!);
      return value.replace(ANY, (_match, path: string) => String(need(path)));
    }
    if (Array.isArray(value)) return value.map(resolve);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, resolve(entry)]));
    }
    return value;
  };

  return resolve(args ?? {}) as Record<string, unknown>;
}

const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function placeholdersIn(template: string): string[] {
  return [...new Set([...template.matchAll(PLACEHOLDER)].map((match) => match[1] as string))];
}

export function quoteArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function render(value: unknown): string | undefined {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.map((entry) => render(entry) ?? '').join(' ');
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return quoteArgument(String(value));
  }
  return undefined;
}

export type CommandRendering =
  | { command: string }
  | { refused: string };

export function renderCommand(template: string, args: Record<string, unknown>): CommandRendering {
  const unusable: string[] = [];

  const command = template.replace(PLACEHOLDER, (_whole, name: string) => {
    const rendered = render(args[name]);
    if (rendered === undefined) unusable.push(name);
    return rendered ?? '';
  });

  if (unusable.length > 0) {
    return { refused: `${unusable.join(' and ')} has to be text, a number, or a list of them` };
  }

  return { command };
}

/**
 * A user-defined validation step "kind" — the extensibility point for the tree-type step vocabulary.
 * A built-in check type (file-exists, run-command, k8s-probe, ...) is a fixed piece of TypeScript;
 * a custom step is pure data: a name, a set of declared parameters, and a shell command template
 * with `{{paramKey}}` placeholders. It resolves to an ordinary `run-command` check at execution time
 * (see `resolveCustomSteps` in `tree-types.ts`) — genuinely new step *kinds* without a plugin/eval
 * system, since "run a shell command" is already the escape hatch every check type ultimately reduces
 * to on this platform.
 */

export type CustomStepFieldKind = 'string' | 'number' | 'boolean';

export interface CustomStepField {
  key: string;
  label: string;
  kind: CustomStepFieldKind;
  defaultValue?: string | number | boolean | undefined;
}

export interface CustomStepDefinition {
  id: string;
  ownerId: string;
  name: string;
  description?: string | undefined;
  fields: CustomStepField[];
  /** Shell command template. `{{fieldKey}}` is replaced with that field's value for a given step instance. */
  command: string;
  timeoutMs?: number | undefined;
  createdAt: string;
  updatedAt: string;
}

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const FIELD_KEY = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function validateCustomStepDefinition(candidate: Partial<CustomStepDefinition>): string | null {
  if (!candidate.id || !SLUG.test(candidate.id)) {
    return 'id must be a slug: lowercase letters, numbers and single hyphens.';
  }
  if (!candidate.name?.trim()) return 'name is required.';
  if (!candidate.command?.trim()) return 'command is required.';

  const fields = candidate.fields ?? [];
  if (!Array.isArray(fields)) return 'fields must be an array.';
  const seen = new Set<string>();
  for (const f of fields) {
    if (!f?.key || !FIELD_KEY.test(f.key)) return `Field key ${JSON.stringify(f?.key ?? '')} must start with a letter or underscore and contain only letters, digits and underscores.`;
    if (seen.has(f.key)) return `Field key "${f.key}" is used more than once.`;
    seen.add(f.key);
    if (!f.label?.trim()) return `Field "${f.key}" needs a label.`;
    if (!['string', 'number', 'boolean'].includes(f.kind)) return `Field "${f.key}": kind must be string, number or boolean.`;
  }

  if (candidate.timeoutMs !== undefined && (typeof candidate.timeoutMs !== 'number' || candidate.timeoutMs <= 0)) {
    return 'timeoutMs must be a positive number.';
  }

  return null;
}

export function substituteTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => values[key] ?? whole);
}

/** Fill a custom step's command template from a step instance's param values. */
export function renderCustomStepCommand(
  definition: Pick<CustomStepDefinition, 'command' | 'fields'>,
  params: Record<string, string | number | boolean> | undefined,
): string {
  const values: Record<string, string> = {};
  for (const f of definition.fields) {
    const v = params?.[f.key] ?? f.defaultValue;
    if (v !== undefined) values[f.key] = String(v);
  }
  return substituteTemplate(definition.command, values);
}

export interface CustomStepStore {
  getCustomStepDefinitions(ownerId: string): Promise<CustomStepDefinition[]>;
}

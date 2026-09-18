interface SchemaText {
  title?: string | undefined;
  describe?: string | undefined;
}

export interface StringSetting extends SchemaText {
  type: 'string';
  default?: string | undefined;
  enum?: readonly string[] | undefined;
  minLength?: number | undefined;
  maxLength?: number | undefined;
  multiline?: boolean | undefined;
}

export interface NumberSetting extends SchemaText {
  type: 'number' | 'integer';
  default?: number | undefined;
  minimum?: number | undefined;
  maximum?: number | undefined;
}

export interface BooleanSetting extends SchemaText {
  type: 'boolean';
  default?: boolean | undefined;
}

export interface ListSetting extends SchemaText {
  type: 'array';
  items: SettingSchema;
  default?: readonly unknown[] | undefined;
  minItems?: number | undefined;
  maxItems?: number | undefined;
}

export interface GroupSetting extends SchemaText {
  type: 'object';
  properties: Readonly<Record<string, SettingSchema>>;
  required?: readonly string[] | undefined;
  default?: Readonly<Record<string, unknown>> | undefined;
}

export type SettingSchema = StringSetting | NumberSetting | BooleanSetting | ListSetting | GroupSetting;

export const NO_SETTINGS: GroupSetting = { type: 'object', properties: {} };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const quoted = (value: unknown): string => JSON.stringify(value) ?? String(value);

export function settingsProblems(schema: SettingSchema, value: unknown, path = 'settings'): string[] {
  switch (schema.type) {
    case 'string': {
      if (typeof value !== 'string') return [`${path} has to be text`];
      if (schema.enum && !schema.enum.includes(value)) {
        return [`${path} has to be one of ${schema.enum.map(quoted).join(', ')}, not ${quoted(value)}`];
      }
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        return [`${path} has to be at least ${schema.minLength} characters`];
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        return [`${path} can be at most ${schema.maxLength} characters`];
      }
      return [];
    }

    case 'number':
    case 'integer': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return [`${path} has to be a number`];
      if (schema.type === 'integer' && !Number.isInteger(value)) return [`${path} has to be a whole number`];
      if (schema.minimum !== undefined && value < schema.minimum) return [`${path} has to be at least ${schema.minimum}`];
      if (schema.maximum !== undefined && value > schema.maximum) return [`${path} can be at most ${schema.maximum}`];
      return [];
    }

    case 'boolean':
      return typeof value === 'boolean' ? [] : [`${path} has to be true or false`];

    case 'array': {
      if (!Array.isArray(value)) return [`${path} has to be a list`];
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        return [`${path} needs at least ${schema.minItems} entries`];
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        return [`${path} can have at most ${schema.maxItems} entries`];
      }
      return value.flatMap((item, index) => settingsProblems(schema.items, item, `${path}[${index}]`));
    }

    case 'object': {
      if (!isRecord(value)) return [`${path} has to be a set of named values`];
      const problems: string[] = [];

      for (const name of schema.required ?? []) {
        if (value[name] === undefined) problems.push(`${path}.${name} is required`);
      }

      for (const [name, entry] of Object.entries(value)) {
        const property = schema.properties[name];
        if (!property) {
          problems.push(`${path} has no setting called "${name}"`);
          continue;
        }
        if (entry === undefined) continue;
        problems.push(...settingsProblems(property, entry, `${path}.${name}`));
      }

      return problems;
    }
  }
}

export function defaultSettings(schema: GroupSetting): Record<string, unknown> {
  const filled: Record<string, unknown> = { ...(schema.default ?? {}) };

  for (const [name, property] of Object.entries(schema.properties)) {
    if (filled[name] !== undefined) continue;
    if (property.type === 'object') {
      const nested = defaultSettings(property);
      if (Object.keys(nested).length > 0) filled[name] = nested;
      continue;
    }
    if (property.default !== undefined) filled[name] = structuredClone(property.default);
  }

  return filled;
}

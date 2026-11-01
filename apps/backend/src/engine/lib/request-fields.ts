export type Fields = Readonly<Record<string, unknown>>;

export const fieldsOf = (body: unknown): Fields => (typeof body === 'object' && body !== null && !Array.isArray(body) ? body as Fields : {});

export const textOf = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

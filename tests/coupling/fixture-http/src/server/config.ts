const KEYS = ['SESSION_KEY', 'DATA_KEY'] as const;

export function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export const settings = () => ({ root: process.env.ROOT_URL, token: required('TOKEN'), keys: KEYS.map((key) => process.env[key]) });

export function dbUrl(env: Record<string, string | undefined> = process.env): string | undefined {
  const { DB_URL } = env;
  return DB_URL;
}

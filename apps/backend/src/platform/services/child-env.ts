export const inheritedEnv = (): NodeJS.ProcessEnv => process.env;

export const childEnv = (extra?: Readonly<Record<string, string | undefined>>): NodeJS.ProcessEnv =>
  (extra ? { ...process.env, ...extra } : process.env);

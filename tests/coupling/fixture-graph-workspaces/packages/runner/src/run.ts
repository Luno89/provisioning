export type Handler = (input: string) => string;

export function run(handlers: Record<string, Handler>, name: string): string {
  const handler = handlers[name];
  if (!handler) throw new Error(`no handler is named ${name}`);
  return handler(name);
}

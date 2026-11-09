export type Handler = (input: string) => Promise<string>;

export async function dispatch(handlers: Record<string, Handler>, name: string, input: string): Promise<string> {
  const handler = handlers[name];
  if (!handler) throw new Error(`no handler is named ${name}`);
  return handler(input);
}

export function around(run: () => Promise<string>): Promise<string> {
  return run();
}

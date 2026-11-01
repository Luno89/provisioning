export function ignore(why: string): (failure?: unknown) => undefined {
  if (!why.trim()) throw new Error('say why the failure does not matter');
  return () => undefined;
}

export function greeterFrom(prefix: string): (name: string) => string {
  return (name) => `${prefix} ${name}`;
}

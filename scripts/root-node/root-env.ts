import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

export function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const values: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match) values[match[1]!] = match[2]!;
  }
  return values;
}

export function setEnvValues(path: string, values: Readonly<Record<string, string>>): void {
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter((line, index, all) => line !== '' || index < all.length - 1) : [];
  for (const [key, value] of Object.entries(values)) {
    if (/[\r\n]/.test(value)) throw new Error(`${key} holds a line break`);
    const at = lines.findIndex((line) => line.startsWith(`${key}=`));
    if (at >= 0) lines[at] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
  }
  writeFileSync(path, `${lines.join('\n')}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function dropEnvValues(path: string, keys: readonly string[]): void {
  if (!existsSync(path)) return;
  const lines = readFileSync(path, 'utf8').split('\n').filter((line, index, all) => line !== '' || index < all.length - 1);
  const kept = lines.filter((line) => !keys.some((key) => line.startsWith(`${key}=`)));
  writeFileSync(path, `${kept.join('\n')}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

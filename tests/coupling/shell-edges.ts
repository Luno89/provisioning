import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { ExtraEnd } from './graph.js';

const URL_AT = /(?:\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Za-z_][A-Za-z0-9_]*|https?:\/\/[^/"'\s]+)(\/[^"'\s?]*)/g;
const DATA = /\s(-d|--data(-binary|-raw|-urlencode)?|-F|--form|--json)\s/;
const FUNCTION = /^\s*(?:function\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(\)\s*\{?\s*$/;

interface Command { text: string; line: number }

function commandsOf(text: string): Command[] {
  const lines = text.split('\n');
  const commands: Command[] = [];
  for (let at = 0; at < lines.length; at += 1) {
    const start = at;
    let joined = lines[at]!;
    while (joined.endsWith('\\') && at + 1 < lines.length) {
      at += 1;
      joined = `${joined.slice(0, -1)} ${lines[at]!.trim()}`;
    }
    if (!/^\s*#/.test(joined)) commands.push({ text: joined, line: start + 1 });
  }
  return commands;
}

const functionAt = (lines: readonly string[], line: number): string => {
  for (let at = line - 1; at >= 0; at -= 1) {
    const found = FUNCTION.exec(lines[at]!);
    if (found) return found[1]!;
    if (/^\}\s*$/.test(lines[at]!) && at < line - 1) return '(script)';
  }
  return '(script)';
};

export function shellEnds(root: string, file: string): ExtraEnd[] {
  const text = readFileSync(join(root, file), 'utf8');
  const lines = text.split('\n');
  const ends: ExtraEnd[] = [];
  for (const command of commandsOf(text)) {
    if (!/\bcurl\b/.test(command.text)) continue;
    const method = /\s(?:-X|--request)\s+([A-Z]+)/.exec(command.text)?.[1] ?? (DATA.test(command.text) ? 'POST' : 'GET');
    for (const found of command.text.matchAll(URL_AT)) {
      const path = found[1]!.replace(/\$\{[^}]+\}|\$[A-Za-z_][A-Za-z0-9_]*/g, ':*').replace(/\/+$/, '') || '/';
      if (!path.startsWith('/api/') && !/^\/[a-z-]+\.sh$/.test(path)) continue;
      ends.push({ unit: { file, line: command.line, name: functionAt(lines, command.line) }, kind: 'http', name: `${method} ${path}`, side: 'sends' });
    }
  }
  return ends;
}

export function shellScripts(root: string, folder: string): string[] {
  return readdirSync(join(root, folder)).flatMap((entry) => {
    const path = join(root, folder, entry);
    if (statSync(path).isDirectory()) return entry === 'node_modules' ? [] : shellScripts(root, relative(root, path));
    return entry.endsWith('.sh') ? [relative(root, path)] : [];
  });
}

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(join(here, p), 'utf8');

describe('picking a service instead of typing its name', () => {
  const editor = read('../components/PersonaEditor.tsx');
  const personasApi = read('../api/personas.ts');

  it('offers what is actually deployed', () => {
    expect(editor).toMatch(/options\?\.mcpServers/);
    expect(personasApi).toMatch(/mcpServers\?: \{ name: string; tools: number; unreachable\?: string \}\[\]/);
  });

  it('toggles a name in and out of scope.mcp', () => {
    expect(editor).toMatch(/const on = \(scope\.mcp \?\? \[\]\)\.includes\(s\.name\)/);
    expect(editor).toMatch(/\(scope\.mcp \?\? \[\]\)\.filter\(\(x\) => x !== s\.name\)/);
  });

  it('still offers a server that is DOWN, labelled', () => {
    expect(editor).toMatch(/s\.unreachable \? 'down'/);
    expect(editor).toMatch(/Not answering: \$\{s\.unreachable\}/);
  });

  it('keeps the free-text field, for a service that is not deployed yet', () => {
    expect(editor).toMatch(/not deployed yet/);
  });

  it('keeps the sealed-persona warning', () => {
    expect(editor).toMatch(/every call will time out/);
  });
});

describe('who is answering', () => {
  const chat = read('../components/Chat.tsx');

  it('names the persona next to the composer', () => {
    expect(chat).toMatch(/Answering:/);
    expect(chat).toMatch(/const activePersona = personas\?\.find\(\(p\) => p\.id === personaId\)/);
  });

  it('says "No persona" explicitly rather than showing nothing', () => {
    expect(chat).toMatch(/No persona/);
    expect(chat).toMatch(/default prompt, no services/);
  });

  it('lists the services that persona can call', () => {
    expect(chat).toMatch(/can call \{\(activePersona\.scope\?\.mcp \?\? \[\]\)\.join\(', '\)\}/);
  });

  it('derives it from the same id the request sends', () => {
    const derived = chat.indexOf('const activePersona =');
    const sent = chat.indexOf('...(personaId ? { personaId } : {})');
    expect(derived).toBeGreaterThan(-1);
    expect(sent).toBeGreaterThan(-1);
  });
});

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Granting a persona a service, and knowing who you are talking to.
 *
 * ── WHY BOTH ARE HERE ──
 * They are the same gap seen from two ends. A persona decides which MCP servers a conversation can
 * call; `scope.mcp` was a free-text comma list, so granting one meant typing a name from memory and
 * matching it exactly — and the selector that chooses the persona sat in a drawer defaulting to
 * "No persona", so the usual case was a conversation with nobody, shown nowhere.
 *
 * Read from source rather than rendered: both are presentational details on components that pull a
 * live query and a streaming chat, and the failure mode for both is the element being DROPPED.
 */

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(join(here, p), 'utf8');

describe('picking a service instead of typing its name', () => {
  const editor = read('../components/PersonaEditor.tsx');
  // The SHAPE moved to api/personas.ts when the editor stopped declaring its own — a test reading
  // source text has to follow the source, or it passes against a file that no longer holds it.
  const personasApi = read('../api/personas.ts');

  it('offers what is actually deployed', () => {
    expect(editor).toMatch(/options\?\.mcpServers/);
    expect(personasApi).toMatch(/mcpServers\?: \{ name: string; tools: number; unreachable\?: string \}\[\]/);
  });

  it('toggles a name in and out of scope.mcp', () => {
    // The grant is the click; nothing else writes this field from the picker.
    expect(editor).toMatch(/const on = \(scope\.mcp \?\? \[\]\)\.includes\(s\.name\)/);
    expect(editor).toMatch(/\(scope\.mcp \?\? \[\]\)\.filter\(\(x\) => x !== s\.name\)/);
  });

  it('still offers a server that is DOWN, labelled', () => {
    /**
     * Hiding it would have the user retype a name that is already right. A server that is not
     * answering is still the one they meant.
     */
    expect(editor).toMatch(/s\.unreachable \? 'down'/);
    expect(editor).toMatch(/Not answering: \$\{s\.unreachable\}/);
  });

  it('keeps the free-text field, for a service that is not deployed yet', () => {
    // Exactly what happens when a plan is about to build one.
    expect(editor).toMatch(/not deployed yet/);
  });

  it('keeps the sealed-persona warning', () => {
    // A grant with no egress means the tools appear and every call times out.
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
    /**
     * The default, and a real choice — but an unlabelled one read as a missing answer. It also
     * means no services, which is invisible at the moment you wonder why the model cannot reach a
     * server you granted to a persona you did not select.
     */
    expect(chat).toMatch(/No persona/);
    expect(chat).toMatch(/default prompt, no services/);
  });

  it('lists the services that persona can call', () => {
    expect(chat).toMatch(/can call \{\(activePersona\.scope\?\.mcp \?\? \[\]\)\.join\(', '\)\}/);
  });

  it('derives it from the same id the request sends', () => {
    // Two sources for "who is answering" would eventually disagree, and the label would be the lie.
    const derived = chat.indexOf('const activePersona =');
    const sent = chat.indexOf('...(personaId ? { personaId } : {})');
    expect(derived).toBeGreaterThan(-1);
    expect(sent).toBeGreaterThan(-1);
  });
});

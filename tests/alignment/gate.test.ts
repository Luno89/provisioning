import { describe, expect, it } from 'vitest';
import type { Answer } from './answers.js';
import { ANSWERS } from './answers.js';
import type { Finding } from './drift.js';
import { gateOf, gateRefusal } from './gate.js';

const finding = (id: string, kind: Finding['kind'], steps: string[] = []): Finding => ({ id, kind, steps, title: `${id} title`, detail: 'detail', where: [] });
const answer = (id: string, state: Answer['state']): Answer => ({ finding: id, state, at: '2026-11-06T23:42', why: 'why' });

describe('the gate between drift and building', () => {
  it('lets through findings that were asked or noted, and known work that needs no question', () => {
    const findings = [finding('assumption:E5', 'assumption', ['E5']), finding('missing:B6', 'missing', ['B6']), finding('decided-not-done:k3d', 'decided-not-done', ['E2'])];
    const gate = gateOf(findings, [answer('assumption:E5', 'asked'), answer('missing:B6', 'noted')]);
    expect(gate.open).toEqual([]);
    expect(gate.asked.map((entry) => entry.id)).toEqual(['assumption:E5']);
    expect(gate.noted.map((entry) => entry.id)).toEqual(['missing:B6']);
    expect(gateRefusal(gate)).toBeUndefined();
  });

  it('refuses while a finding for the owner was never asked, naming it and its steps', () => {
    const gate = gateOf([finding('undecided-branch:sudo', 'undecided-branch', ['C1', 'E4'])], []);
    expect(gate.open.map((entry) => entry.id)).toEqual(['undecided-branch:sudo']);
    expect(gateRefusal(gate)).toContain('not asked: undecided-branch:sudo title (C1, E4)');
  });

  it('refuses an answer whose finding is gone, so the ledger keeps only what is still true', () => {
    const gate = gateOf([], [answer('missing:B6', 'noted')]);
    expect(gateRefusal(gate)).toContain('answered, but no longer found: missing:B6');
  });

  it('keeps every shipped answer to one finding, with when and why', () => {
    expect(new Set(ANSWERS.map((entry) => entry.finding)).size).toBe(ANSWERS.length);
    for (const entry of ANSWERS) expect(entry.why.length, entry.finding).toBeGreaterThan(0);
  });
});

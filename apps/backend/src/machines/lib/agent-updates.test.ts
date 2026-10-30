import { describe, expect, it } from 'vitest';
import { agentUpdateReportFrom, agentUpdateView, reportedBundle } from './agent-updates.js';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const AT = '2026-10-30T10:00:00.000Z';

describe('which agent a machine says it runs', () => {
  it('is the sha256 of its bundle, sent when it connects', () => {
    expect(reportedBundle({ token: 't', bundle: A })).toBe(A);
  });

  it('is nothing when it sends none, an empty one, or something else', () => {
    expect(reportedBundle({ token: 't' })).toBeUndefined();
    expect(reportedBundle({ token: 't', bundle: '' })).toBeUndefined();
    expect(reportedBundle({ bundle: 'A'.repeat(64) })).toBeUndefined();
    expect(reportedBundle(undefined)).toBeUndefined();
  });
});

describe('what a machine says about updating its agent', () => {
  it('keeps a well-formed report, with the reason a failure gives', () => {
    expect(agentUpdateReportFrom({ state: 'failed', bundle: B, reason: ' npm ci failed ' }, AT)).toEqual({ state: 'failed', bundle: B, reason: 'npm ci failed', at: AT });
    expect(agentUpdateReportFrom({ state: 'waiting', bundle: B, busyWith: ['a session of gemini', 3, ''] }, AT)).toEqual({ state: 'waiting', bundle: B, busyWith: ['a session of gemini'], at: AT });
    expect(agentUpdateReportFrom({ state: 'updating', bundle: B, reason: 'ignored' }, AT)).toEqual({ state: 'updating', bundle: B, at: AT });
  });

  it('says a failure that gave no reason did not say why, and trims a long one', () => {
    expect(agentUpdateReportFrom({ state: 'failed', bundle: B }, AT)?.reason).toBe('it did not say why');
    expect(agentUpdateReportFrom({ state: 'failed', bundle: B, reason: 'x'.repeat(5000) }, AT)?.reason).toHaveLength(1000);
  });

  it('drops anything else', () => {
    expect(agentUpdateReportFrom({ state: 'current', bundle: B }, AT)).toBeUndefined();
    expect(agentUpdateReportFrom({ state: 'failed', bundle: 'nope' }, AT)).toBeUndefined();
    expect(agentUpdateReportFrom('failed', AT)).toBeUndefined();
  });
});

describe('the agent state My Machines shows', () => {
  it('says nothing while Koala cannot name its own agent, or about a machine that never connected', () => {
    expect(agentUpdateView({ lastSeenAt: AT, agentBundle: A }, undefined)).toBeUndefined();
    expect(agentUpdateView({}, A)).toBeUndefined();
  });

  it('is up to date when it runs the bundle Koala serves, whatever it said before', () => {
    expect(agentUpdateView({ lastSeenAt: AT, agentBundle: A, agentUpdate: { state: 'failed', bundle: A, reason: 'x', at: AT } }, A)).toEqual({ state: 'current', current: A, running: A });
  });

  it('is too old to update itself when it connected without saying which agent it runs', () => {
    expect(agentUpdateView({ lastSeenAt: AT }, A)).toEqual({ state: 'too-old', current: A });
  });

  it('follows what it said about the bundle Koala serves now', () => {
    expect(agentUpdateView({ lastSeenAt: AT, agentBundle: A, agentUpdate: { state: 'waiting', bundle: B, busyWith: ['a command'], at: AT } }, B))
      .toEqual({ state: 'waiting', current: B, running: A, busyWith: ['a command'], at: AT });
    expect(agentUpdateView({ lastSeenAt: AT, agentBundle: A, agentUpdate: { state: 'updating', bundle: B, at: AT } }, B)?.state).toBe('updating');
    expect(agentUpdateView({ lastSeenAt: AT, agentBundle: A, agentUpdate: { state: 'failed', bundle: B, reason: 'npm ci failed', at: AT } }, B))
      .toEqual({ state: 'failed', current: B, running: A, reason: 'npm ci failed', at: AT });
    expect(agentUpdateView({ lastSeenAt: AT, agentBundle: A, agentUpdate: { state: 'not-a-service', bundle: B, at: AT } }, B)?.state).toBe('not-a-service');
  });

  it('is behind when Koala serves a newer agent it has not heard about, and ignores what it said about an older one', () => {
    expect(agentUpdateView({ lastSeenAt: AT, agentBundle: A }, B)).toEqual({ state: 'behind', current: B, running: A });
    expect(agentUpdateView({ lastSeenAt: AT, agentBundle: A, agentUpdate: { state: 'failed', bundle: 'c'.repeat(64), reason: 'old', at: AT } }, B)).toEqual({ state: 'behind', current: B, running: A });
  });
});

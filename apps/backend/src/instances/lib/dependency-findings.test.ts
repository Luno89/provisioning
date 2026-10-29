import { describe, expect, it } from 'vitest';
import { findingKey, fixingRelease, judged, mergeFindings, tellingMessage, type Sighting } from './dependency-findings.js';

const sighting = (fixed: string[], overrides: Partial<Sighting> = {}): Sighting => ({
  component: { name: 'seroval', version: '1.6.9', kind: 'npm', in: 'koala' },
  advisory: { id: 'GHSA-f86p', severity: 'moderate', fixed },
  releases: ['v2026.10.29'],
  instances: ['luno'],
  ...overrides,
});

const day = (iso: string) => new Date(`${iso}T12:00:00Z`);

describe('a finding\'s state, by the same two-week rule as ship', () => {
  it('waits while the fix is under two weeks old, is due after, and says when there is no fix', () => {
    expect(judged(sighting(['1.6.11']), () => '2026-10-18T00:00:00Z', day('2026-10-29'))).toEqual({ fix: '1.6.11', fixPublishedAt: '2026-10-18T00:00:00Z', takeOn: '2026-11-01', state: 'waiting' });
    expect(judged(sighting(['1.6.11']), () => '2026-10-10T00:00:00Z', day('2026-10-29')).state).toBe('due');
    expect(judged(sighting([]), () => undefined, day('2026-10-29'))).toEqual({ state: 'no-fix' });
    expect(judged(sighting(['1.6.11']), () => undefined, day('2026-10-29'))).toEqual({ fix: '1.6.11', state: 'due' });
  });
});

describe('telling the operator once', () => {
  it('tells a new advisory once, then again only when its fix becomes due, and lets a gone one go', () => {
    const published = () => '2026-10-18T00:00:00Z';
    const first = mergeFindings([], [sighting(['1.6.11'])], published, day('2026-10-29'));
    expect(first.tell.map((entry) => entry.why)).toEqual(['appeared']);
    expect(first.findings[0]).toMatchObject({ state: 'waiting', told: { appeared: '2026-10-29T12:00:00.000Z' } });

    const quiet = mergeFindings(first.findings, [sighting(['1.6.11'])], published, day('2026-10-30'));
    expect(quiet.tell).toEqual([]);
    expect(quiet.findings[0]!.firstSeenAt).toBe('2026-10-29T12:00:00.000Z');

    const due = mergeFindings(quiet.findings, [sighting(['1.6.11'])], published, day('2026-11-02'));
    expect(due.tell.map((entry) => entry.why)).toEqual(['due']);
    expect(mergeFindings(due.findings, [sighting(['1.6.11'])], published, day('2026-11-03')).tell).toEqual([]);

    const gone = mergeFindings(due.findings, [], published, day('2026-11-04'));
    expect(gone.findings).toEqual([]);
    expect(gone.resolved.map((finding) => finding.key)).toEqual([findingKey(sighting([]).component, 'GHSA-f86p')]);
  });

  it('tells a finding already due when it first appears in one message, not two', () => {
    const merged = mergeFindings([], [sighting(['1.6.8'], { component: { name: 'seroval', version: '1.6.7', kind: 'npm', in: 'koala' } })], () => '2026-09-29T00:00:00Z', day('2026-10-29'));
    expect(merged.tell.map((entry) => entry.why)).toEqual(['appeared']);
    expect(merged.findings[0]!.told).toEqual({ appeared: '2026-10-29T12:00:00.000Z', due: '2026-10-29T12:00:00.000Z' });
    const message = tellingMessage(merged.tell, 'https://app.example.com')!;
    expect(message.subject).toBe('Koala\'s dependencies: 1 new advisory');
    expect(message.text).toContain('seroval@1.6.7: GHSA-f86p (moderate); fixed in 1.6.8, published 2026-09-29: update it now. Running in v2026.10.29 on 1 instance.');
    expect(message.text).toContain('https://app.example.com/#/admin');
    expect(tellingMessage([], '')).toBeUndefined();
  });
});

describe('the release that fixes a finding', () => {
  it('is the newest release whose inventory has the component at or past the fix', () => {
    const [finding] = mergeFindings([], [sighting(['1.6.11'])], () => '2026-10-18T00:00:00Z', day('2026-10-29')).findings;
    const release = (label: string, version: string) => ({ release: label, label, components: [{ ref: label, name: 'seroval', version, kind: 'npm' as const, in: 'koala', dev: false, floating: false }] });
    expect(fixingRelease(finding!, [release('v2026.11.01', '1.6.10')])).toBeUndefined();
    expect(fixingRelease(finding!, [release('v2026.11.01', '1.6.10'), release('v2026.11.05', '1.6.11'), release('v2026.11.09', '1.6.12')])).toBe('v2026.11.09');
  });
});

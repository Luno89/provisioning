import { describe, it, expect } from 'vitest';
import {
  compareProgress, decideExtension, refusalReason, extensionNotice,
  MAX_EXTENSIONS, EXTENSION_FRACTION, type ProgressSample, type ExtensionState,
} from './budget-extension.js';

const at = (step: number, tokens: number) => ({ step, tokens });

const sample = (over: Partial<ProgressSample> = {}): ProgressSample => ({
  at: at(10, 10_000), ...over,
});

const state = (over: Partial<ExtensionState> = {}): ExtensionState => ({
  exhausted: 'tokens',
  extensionsUsed: 0,
  evidence: { moved: true, reasons: ['its tests now pass'], churnOnly: false },
  thrashing: false,
  circling: false,
  silent: false,
  originalMaxSteps: 40,
  originalMaxTokens: 100_000,
  ...over,
});

describe('what counts as progress', () => {
  it('sees a verification go green', () => {
    const out = compareProgress(sample({ verify: 'failed' }), sample({ verify: 'passed' }));
    expect(out.moved).toBe(true);
    expect(out.reasons[0]).toContain('tests now pass');
    expect(out.churnOnly).toBe(false);
  });

  it('does not count a verification that was already green', () => {
    expect(compareProgress(sample({ verify: 'passed' }), sample({ verify: 'passed' })).moved).toBe(false);
  });

  it('sees promised files appear', () => {
    const out = compareProgress(sample({ missingArtifacts: 3 }), sample({ missingArtifacts: 1 }));
    expect(out.moved).toBe(true);
    expect(out.reasons[0]).toContain('2 more of the files it promised');
  });

  it('does not count files going MISSING as movement', () => {
    expect(compareProgress(sample({ missingArtifacts: 1 }), sample({ missingArtifacts: 3 })).moved).toBe(false);
  });

  it('sees a deliverable reach the bar, and sees it grow', () => {
    expect(compareProgress(
      sample({ findingsOutcome: 'unverified' }),
      sample({ findingsOutcome: 'passed' }),
    ).moved).toBe(true);

    expect(compareProgress(
      sample({ findingsChars: 1000 }),
      sample({ findingsChars: 2000 }),
    ).reasons[0]).toContain('grew substantially');
  });

  it('ignores a deliverable that barely moved', () => {
    expect(compareProgress(sample({ findingsChars: 1000 }), sample({ findingsChars: 1050 })).moved).toBe(false);
  });

  it('sees new commits', () => {
    expect(compareProgress(sample({ commits: 1 }), sample({ commits: 3 })).reasons[0]).toContain('2 new commits');
  });

  it('treats a first sample as a baseline, not as progress', () => {
    expect(compareProgress(undefined, sample({ commits: 0, changedLines: 0 })).moved).toBe(false);
  });
});

describe('churn, which is the signal that can be faked', () => {
  it('counts on its own, but is marked as churn', () => {
    const out = compareProgress(sample({ changedLines: 0 }), sample({ changedLines: 200 }));
    expect(out.moved).toBe(true);
    expect(out.churnOnly).toBe(true);
  });

  it('is not marked as churn when something real moved too', () => {
    const out = compareProgress(
      sample({ changedLines: 0, verify: 'failed' }),
      sample({ changedLines: 200, verify: 'passed' }),
    );
    expect(out.churnOnly).toBe(false);
  });

  it('ignores a trivial diff', () => {
    expect(compareProgress(sample({ changedLines: 0 }), sample({ changedLines: 3 })).moved).toBe(false);
  });
});

describe('the vetoes', () => {
  it('refuses a thrashing run even with perfect evidence', () => {
    expect(decideExtension(state({ thrashing: true }))).toBeUndefined();
  });

  it('refuses a circling run', () => {
    expect(decideExtension(state({ circling: true }))).toBeUndefined();
  });

  it('refuses a run that stopped calling tools', () => {
    expect(decideExtension(state({ silent: true }))).toBeUndefined();
  });

  it('refuses on ANY veto, whatever else is true', () => {
    for (const veto of ['thrashing', 'circling', 'silent'] as const) {
      const s = state({ [veto]: true, evidence: { moved: true, reasons: ['its tests now pass'], churnOnly: false } });
      expect(decideExtension(s), veto).toBeUndefined();
    }
  });
});

describe('granting more room', () => {
  it('extends a producing run that ran out of tokens', () => {
    const out = decideExtension(state())!;
    expect(out.tokens).toBe(50_000);
    expect(out.reason).toContain('its tests now pass');
  });

  it('extends steps when steps were what ran out', () => {
    const out = decideExtension(state({ exhausted: 'steps' }))!;
    expect(out.steps).toBe(20);
    expect(out.tokens).toBeUndefined();
  });

  it('refuses a run with nothing to show', () => {
    expect(decideExtension(state({ evidence: { moved: false, reasons: [], churnOnly: false } }))).toBeUndefined();
  });

  it('stops after the cap', () => {
    expect(decideExtension(state({ extensionsUsed: MAX_EXTENSIONS }))).toBeUndefined();
  });

  it('never compounds', () => {
    const first = decideExtension(state({ extensionsUsed: 0 }))!;
    const second = decideExtension(state({ extensionsUsed: 1 }))!;
    expect(second.tokens).toBe(first.tokens);
    expect(first.tokens! + second.tokens!).toBe(100_000 * EXTENSION_FRACTION * 2);
  });

  it('lets churn buy one extension but not a second', () => {
    const churn = { moved: true, reasons: ['200 lines changed since the last check'], churnOnly: true };
    expect(decideExtension(state({ evidence: churn, extensionsUsed: 0 }))).toBeDefined();
    expect(decideExtension(state({ evidence: churn, extensionsUsed: 1 }))).toBeUndefined();
  });
});

describe('what the tree can afford', () => {
  it('never grants more than the root budget has left', () => {
    const out = decideExtension(state({ headroomTokens: 12_000 }))!;
    expect(out.tokens).toBe(12_000);
  });

  it('refuses a grant too small to produce anything', () => {
    expect(decideExtension(state({ headroomTokens: 500 }))).toBeUndefined();
  });

  it('grants the full amount when no budget is enforced', () => {
    expect(decideExtension(state({ headroomTokens: undefined }))!.tokens).toBe(50_000);
  });
});

describe('telling the agent', () => {
  it('names the new ceiling and overrides the stale one', () => {
    const notice = extensionNotice({ tokens: 50_000, reason: 'granted because its tests now pass' }, 150_000, 'tokens');
    expect(notice).toContain('150,000 tokens');
    expect(notice).toContain('Ignore any earlier statement of your budget');
  });

  it('says why, so the agent knows which thread was the productive one', () => {
    const notice = extensionNotice({ tokens: 1, reason: 'granted because its tests now pass' }, 2, 'tokens');
    expect(notice).toContain('its tests now pass');
  });
});

describe('explaining a refusal', () => {
  it('says nothing when the extension was granted', () => {
    expect(refusalReason(state())).toBeUndefined();
  });

  it('names the veto rather than the evidence it overruled', () => {
    const s = state({ thrashing: true, evidence: { moved: true, reasons: ['its tests now pass'], churnOnly: false } });
    expect(refusalReason(s)).toMatch(/thrashing/);
    expect(refusalReason(s)).not.toMatch(/tests now pass/);
  });

  it('distinguishes the three vetoes', () => {
    expect(refusalReason(state({ circling: true }))).toMatch(/repeating/);
    expect(refusalReason(state({ silent: true }))).toMatch(/stopped calling tools/);
  });

  it('explains a cap, a flat run, and an exhausted request budget', () => {
    expect(refusalReason(state({ extensionsUsed: MAX_EXTENSIONS }))).toMatch(/already extended/);
    expect(refusalReason(state({ evidence: { moved: false, reasons: [], churnOnly: false } }))).toMatch(/nothing measurable/);
    expect(refusalReason(state({ headroomTokens: 500 }))).toMatch(/nothing meaningful left/);
  });

  it('agrees with decideExtension on every combination that matters', () => {
    const cases: Partial<ExtensionState>[] = [
      {},
      { thrashing: true }, { circling: true }, { silent: true },
      { extensionsUsed: MAX_EXTENSIONS },
      { evidence: { moved: false, reasons: [], churnOnly: false } },
      { evidence: { moved: true, reasons: ['churn'], churnOnly: true }, extensionsUsed: 1 },
      { headroomTokens: 500 },
      { headroomTokens: 12_000 },
      { exhausted: 'steps' },
    ];
    for (const over of cases) {
      const s = state(over);
      const granted = Boolean(decideExtension(s));
      const refused = Boolean(refusalReason(s));
      expect(granted, JSON.stringify(over)).toBe(!refused);
    }
  });
});

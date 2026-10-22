import { describe, expect, it } from 'vitest';
import { afterStep, DAY_MS, extendedTrial, nextTrialStep, trialMessage, trialSchedule, type TrialState } from './pool-trial.js';

const END = '2026-11-03T12:00:00.000Z';
const end = Date.parse(END);

describe('a trial\'s steps', () => {
  it('warns three days and one day before the end, then stops the instance at the end', () => {
    const start = end - 14 * DAY_MS;
    let state: TrialState = { trialEndsAt: END };
    expect(nextTrialStep(state, start)).toEqual({ step: 'warn-3d', at: end - 3 * DAY_MS });
    state = afterStep(state, 'warn-3d', end - 3 * DAY_MS);
    expect(nextTrialStep(state, end - 3 * DAY_MS)).toEqual({ step: 'warn-1d', at: end - DAY_MS });
    state = afterStep(state, 'warn-1d', end - DAY_MS);
    expect(nextTrialStep(state, end - DAY_MS)).toEqual({ step: 'pause', at: end });
  });

  it('keeps a stopped instance thirty days, warning three days before it deletes it', () => {
    const paused = afterStep({ trialEndsAt: END, told: ['warn-3d', 'warn-1d'] }, 'pause', end);
    expect(paused.pausedAt).toBe(END);
    expect(nextTrialStep(paused, end)).toEqual({ step: 'last-warning', at: end + 27 * DAY_MS });
    const warned = afterStep(paused, 'last-warning', end + 27 * DAY_MS);
    expect(nextTrialStep(warned, end + 27 * DAY_MS)).toEqual({ step: 'delete', at: end + 30 * DAY_MS });
  });

  it('sends only the warning still ahead when a trial starts short, and none when it starts past its end', () => {
    expect(nextTrialStep({ trialEndsAt: END }, end - 2 * DAY_MS)).toEqual({ step: 'warn-3d', at: end - 3 * DAY_MS });
    expect(nextTrialStep({ trialEndsAt: END }, end - 12 * 3600_000)).toEqual({ step: 'warn-1d', at: end - DAY_MS });
    expect(nextTrialStep({ trialEndsAt: END }, end + 1)).toEqual({ step: 'pause', at: end });
  });

  it('after an extension, warns again before the new end, and starts a stopped instance again', () => {
    const warned: TrialState = { trialEndsAt: END, told: ['warn-3d', 'warn-1d'] };
    const later = new Date(end + 7 * DAY_MS).toISOString();
    expect(extendedTrial(warned, later, end - 12 * 3600_000)).toEqual({ trialEndsAt: later, told: [] });
    expect(nextTrialStep(extendedTrial(warned, later, end - 12 * 3600_000), end - 12 * 3600_000).step).toBe('warn-3d');

    const paused: TrialState = { trialEndsAt: END, told: ['warn-3d', 'warn-1d', 'pause', 'last-warning'], pausedAt: END };
    const muchLater = new Date(end + 40 * DAY_MS).toISOString();
    const revived = extendedTrial(paused, muchLater, end + 28 * DAY_MS);
    expect(nextTrialStep(revived, end + 28 * DAY_MS)).toEqual({ step: 'resume', at: end + 28 * DAY_MS });
    expect(afterStep(revived, 'resume', end + 28 * DAY_MS)).toEqual({ trialEndsAt: muchLater, told: [] });
    expect(nextTrialStep(extendedTrial(paused, later, end + 28 * DAY_MS), end + 28 * DAY_MS).step).toBe('last-warning');
  });

  it('keeps a warning already sent when the new end still puts it in the past', () => {
    const nearer = new Date(end - DAY_MS).toISOString();
    expect(extendedTrial({ trialEndsAt: END, told: ['warn-3d'] }, nearer, end - 2.5 * DAY_MS)).toEqual({ trialEndsAt: nearer, told: ['warn-3d'] });
  });
});

describe('what a person is told', () => {
  const input = { name: 'alice', trialEndsAt: END, rootUrl: 'https://app.koala.dev' };

  it('names the dates, and every message before the deletion says how to keep the work', () => {
    expect(trialSchedule(END).delete).toBe(end + 30 * DAY_MS);
    for (const step of ['warn-3d', 'warn-1d', 'pause', 'last-warning'] as const) {
      expect(trialMessage(step, input).text).toContain('move your instance to a machine of your own from https://app.koala.dev');
    }
    expect(trialMessage('warn-1d', input).subject).toBe('Your Koala trial ends on Tue, 03 Nov 2026');
    expect(trialMessage('last-warning', input).subject).toBe('Your stopped Koala instance is deleted on Thu, 03 Dec 2026');
    expect(trialMessage('resume', input).text).toContain('running again');
  });
});

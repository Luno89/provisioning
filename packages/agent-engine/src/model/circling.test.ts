import { describe, expect, it } from 'vitest';
import { circlingNudge, sameCircle } from './circling.js';

const plan = 'Plan: run the browser spec to confirm it passes, then write a scratch spec that renders the report and asserts the barcode, then delete it.';

describe('a model going in circles', () => {
  it('counts a second attempt that goes over the same plan as the same circle', () => {
    expect(sameCircle(`${plan} Hmm, I would need to sign in. ${plan}`, `${plan} ${plan} Hmm.`)).toBe(true);
  });

  it('counts an attempt that moved on as progress', () => {
    expect(sameCircle(`${plan} ${plan}`, 'I ran odoo-check and read the rendered HTML: every label page carries an img whose alt is Barcode WH/OUT/00001.')).toBe(false);
  });

  it('shows the model the end of where it was stuck and tells it to decide', () => {
    const nudge = circlingNudge(`${'x '.repeat(2000)}${plan}`);
    expect(nudge).toContain(plan);
    expect(nudge).toContain('…');
    expect(nudge.length).toBeLessThan(2000);
    expect(nudge).toContain('Pick the one that best fits what you were asked and act on it now.');
  });
});

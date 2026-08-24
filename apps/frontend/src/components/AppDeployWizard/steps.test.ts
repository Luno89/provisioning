import { describe, it, expect } from 'vitest'
import { nextStep, prevStep, isModelApp, hasDatabase, FIRST_STEP, LAST_STEP } from './steps'

/**
 * The step branching, tested without mounting anything.
 *
 * As two closures inside `App.tsx` this could only be exercised by rendering a 2,800-line component
 * and clicking through six screens — which is why the conditional skips had no coverage at all.
 */

describe('moving forward', () => {
  it('shows the model step only for apps that serve a model', () => {
    // Asking WordPress which Hugging Face repo to use is asking for a value it will discard.
    expect(nextStep(2, 'vllm')).toBe(3)
    expect(nextStep(2, 'tabbyapi')).toBe(3)
    expect(nextStep(2, 'wordpress')).toBe(4)
  })

  it('skips the database step for apps that have no database', () => {
    // Odoo ships with Postgres; Palworld does not.
    expect(hasDatabase('odoo')).toBe(true)
    expect(nextStep(4, 'odoo')).toBe(5)
    expect(nextStep(4, 'palworld')).toBe(6)
  })

  it('stops at the last step', () => {
    expect(nextStep(LAST_STEP, 'odoo')).toBe(LAST_STEP)
  })
})

describe('going back', () => {
  it('retraces the same skips, so Back is not a different path than Next', () => {
    /**
     * The bug this prevents: forward skipping a step while backward visits it strands the user on a
     * screen they were never shown, with empty fields and no idea what to enter.
     *
     * Walks FORWARD from the first step rather than iterating 1..6, because not every step is
     * reachable for every app type — vLLM has no database, so it never lands on 5, and asserting a
     * round trip through it would be asserting about a state the wizard cannot be in. (The first
     * version of this test did exactly that and failed on it.)
     */
    for (const appType of ['vllm', 'tabbyapi', 'wordpress', 'odoo', 'palworld']) {
      let step = FIRST_STEP
      const visited = [step]
      while (step < LAST_STEP) {
        const forward = nextStep(step, appType)
        expect(prevStep(forward, appType), `${appType}: ${step} -> ${forward} -> back`).toBe(step)
        step = forward
        visited.push(step)
      }
      // And the walk actually terminates at the review step rather than looping.
      expect(visited.at(-1), appType).toBe(LAST_STEP)
    }
  })

  it('stops at the first step', () => {
    expect(prevStep(FIRST_STEP, 'odoo')).toBe(FIRST_STEP)
  })
})

describe('isModelApp', () => {
  it('names exactly the two that serve a model', () => {
    expect(isModelApp('vllm')).toBe(true)
    expect(isModelApp('tabbyapi')).toBe(true)
    for (const other of ['odoo', 'wordpress', 'openwebui', 'palworld']) {
      expect(isModelApp(other), other).toBe(false)
    }
  })
})

import { describe, it, expect } from 'vitest'
import { nextStep, prevStep, isModelApp, hasDatabase, FIRST_STEP, LAST_STEP } from './steps'

describe('moving forward', () => {
  it('shows the model step only for apps that serve a model', () => {
    expect(nextStep(2, 'vllm')).toBe(3)
    expect(nextStep(2, 'tabbyapi')).toBe(3)
    expect(nextStep(2, 'wordpress')).toBe(4)
  })

  it('skips the database step for apps that have no database', () => {
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
    for (const appType of ['vllm', 'tabbyapi', 'wordpress', 'odoo', 'palworld']) {
      let step = FIRST_STEP
      const visited = [step]
      while (step < LAST_STEP) {
        const forward = nextStep(step, appType)
        expect(prevStep(forward, appType), `${appType}: ${step} -> ${forward} -> back`).toBe(step)
        step = forward
        visited.push(step)
      }
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

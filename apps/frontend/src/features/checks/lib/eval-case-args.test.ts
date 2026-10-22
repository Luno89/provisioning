import { describe, it, expect } from 'vitest'
import { argLine, parseArgLine, parseArgLines } from './eval-case-args'

describe('writing argument checks as lines', () => {
  it('round-trips every kind of check', () => {
    const checks = [
      { arg: 'procedure', is: 'research' },
      { arg: 'source', contains: 'tidy' },
      { arg: 'source', matches: '"schema"' },
      { arg: 'source', nonEmpty: true as const },
    ]

    for (const check of checks) expect(parseArgLine(argLine(check))).toEqual(check)
  })

  it('refuses a line that says nothing to check', () => {
    expect(parseArgLine('procedure')).toContain('has to read like')
  })

  it('refuses a line that says how but not what', () => {
    expect(parseArgLine('source contains')).toContain('does not say what')
  })

  it('keeps the checks it understood and reports the ones it did not', () => {
    const { checks, problems } = parseArgLines('procedure is research\nnonsense\n\nsource contains tidy')

    expect(checks).toEqual([{ arg: 'procedure', is: 'research' }, { arg: 'source', contains: 'tidy' }])
    expect(problems).toHaveLength(1)
  })
})

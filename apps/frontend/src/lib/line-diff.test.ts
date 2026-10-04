import { describe, it, expect } from 'vitest'
import { lineDiff } from './line-diff'

describe('lineDiff', () => {
  it('keeps unchanged lines and marks what was taken out and put in, in order', () => {
    expect(lineDiff('You help.\nAsk first.\nBe brief.', 'You help.\nCheck list_infrastructure first.\nBe brief.')).toEqual([
      { kind: 'same', line: 'You help.' },
      { kind: 'removed', line: 'Ask first.' },
      { kind: 'added', line: 'Check list_infrastructure first.' },
      { kind: 'same', line: 'Be brief.' },
    ])
  })

  it('shows lines added at the end, and nothing changed when nothing did', () => {
    expect(lineDiff('a', 'a\nb')).toEqual([{ kind: 'same', line: 'a' }, { kind: 'added', line: 'b' }])
    expect(lineDiff('a\nb', 'a\nb').every((line) => line.kind === 'same')).toBe(true)
  })
})

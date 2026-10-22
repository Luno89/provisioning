import { describe, expect, it } from 'vitest'
import { noticeRepeats } from './notice-repeats'

const notice = (text: string) => ({ role: 'notice', notice: { text } })

describe('notices said again and again', () => {
  it('shows a run of the same notice once, at its last place, with how many times', () => {
    const messages = [notice('stopped'), notice('stopped'), notice('stopped'), notice('landed'), { role: 'user' }, notice('stopped')]
    expect([...noticeRepeats(messages).entries()]).toEqual([[0, 0], [1, 0], [2, 3], [3, 1], [5, 1]])
  })
})

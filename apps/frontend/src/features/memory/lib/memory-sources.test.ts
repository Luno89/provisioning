import { describe, expect, it } from 'vitest'
import { ANY_SOURCE, OUTSIDE_SOURCE, fromOutside, matchesSource, sourceChoices, sourcesLine } from './memory-sources'

const fromWeb = { provenance: { sources: { classes: ['web'], hosts: ['some.example'], runs: ['r1'] } } }
const fromRepo = { provenance: { sources: { classes: ['repo'], hosts: [], runs: ['r2'] } } }
const told = {}

describe('where a memory was learned', () => {
  it('says it in plain words, with the hosts read', () => {
    expect(sourcesLine(fromWeb)).toBe('learned while reading the web (some.example)')
    expect(sourcesLine(told)).toBeUndefined()
  })

  it('tells outside text from the person\'s own', () => {
    expect(fromOutside(fromWeb)).toBe(true)
    expect(fromOutside(fromRepo)).toBe(false)
  })

  it('offers a filter by outside text, by kind and by host, only when any memory has sources', () => {
    expect(sourceChoices([told])).toEqual([])
    expect(sourceChoices([fromWeb, fromRepo]).map((choice) => choice.value)).toEqual([OUTSIDE_SOURCE, 'repo', 'web', 'host:some.example'])
  })

  it('filters by each', () => {
    const all = [fromWeb, fromRepo, told]
    expect(all.filter((one) => matchesSource(one, ANY_SOURCE))).toHaveLength(3)
    expect(all.filter((one) => matchesSource(one, OUTSIDE_SOURCE))).toEqual([fromWeb])
    expect(all.filter((one) => matchesSource(one, 'host:some.example'))).toEqual([fromWeb])
    expect(all.filter((one) => matchesSource(one, 'repo'))).toEqual([fromRepo])
  })
})

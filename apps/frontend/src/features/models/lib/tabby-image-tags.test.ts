import { describe, expect, it } from 'vitest'
import { tabbyImageOptions } from './tabby-image-tags'

describe('the TabbyAPI builds a person can pick', () => {
  it('offers the build Koala pins first, sent as no tag, and says every published tag follows TabbyAPI\'s newest', () => {
    expect(tabbyImageOptions(['latest', 'cu13'], ['latest'])).toEqual([
      { tag: '', cached: false, label: 'the build Koala pins — CUDA 12.8' },
      { tag: 'latest', cached: true, label: 'latest — CUDA 12.8, TabbyAPI\'s newest, not pinned' },
      { tag: 'cu13', cached: false, label: 'cu13 — CUDA 13.x, TabbyAPI\'s newest, not pinned' },
    ])
  })

  it('still offers the pinned build when no tag could be read', () => {
    expect(tabbyImageOptions([], [])).toEqual([{ tag: '', cached: false, label: 'the build Koala pins — CUDA 12.8' }])
  })
})

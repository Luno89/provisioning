import { describe, expect, it } from 'vitest'
import { releaseKind } from './release-kind'
import type { OdooRelease } from '../../../api/releases'

const release = (id: string, image: string, startedAt: string, extra: Partial<OdooRelease> = {}): OdooRelease =>
  ({ id, projectId: 'p1', pipelineRunId: id, commit: `${image}-commit`, image, state: 'superseded', host: 'h', startedAt, updatedAt: startedAt, ...extra })

describe('releaseKind', () => {
  const first = release('r1', 'img:a', '2026-10-01')
  const second = release('r2', 'img:b', '2026-10-02')

  it('calls a release whose image no earlier release had new code', () => {
    expect(releaseKind(first, [first, second])).toEqual({ kind: 'new-code' })
    expect(releaseKind(second, [first, second])).toEqual({ kind: 'new-code' })
  })

  it('calls a release made with Release this build again a release again, naming the commit it repeats', () => {
    const again = release('r3', 'img:b', '2026-10-03', { again: 'r2' })
    expect(releaseKind(again, [first, second, again])).toEqual({ kind: 'again', of: 'img:b-commit' })
  })

  it('calls any other release of an image already released the same image, naming the first commit it was released as', () => {
    const same = release('r3', 'img:a', '2026-10-03')
    expect(releaseKind(same, [first, second, same])).toEqual({ kind: 'same-image', as: 'img:a-commit' })
  })
})

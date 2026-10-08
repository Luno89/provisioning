import { describe, it, expect } from 'vitest'
import { mentionsArtifacts } from './artifact-storage'

describe('a report that left browser files behind', () => {
  it('is one that links an artifact', () => {
    expect(mentionsArtifacts('what the browser left behind:\n- [signs-in/trace.zip](/api/artifacts/0f8e4c2a-1b2c-4d5e-8f90-123456789abc)')).toBe(true)
    expect(mentionsArtifacts('its own checks failed: missing.txt is not there')).toBe(false)
    expect(mentionsArtifacts(undefined)).toBe(false)
  })
})

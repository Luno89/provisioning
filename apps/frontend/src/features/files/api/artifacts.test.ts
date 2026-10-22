import { describe, it, expect } from 'vitest'
import { API_BASE } from '../../../api/client'
import { artifactUrl, withArtifactAddresses } from './artifacts'

describe('artifact addresses', () => {
  it('point at the backend, so a screenshot opens from the dev server too', () => {
    expect(artifactUrl('0f8e4c2a-1b2c')).toBe(`${API_BASE}/artifacts/0f8e4c2a-1b2c`)
    expect(withArtifactAddresses('- shot:\n\n  ![shot.png](/api/artifacts/0f8e4c2a)\n- [trace.zip](/api/artifacts/1a2b3c4d)')).toBe(`- shot:\n\n  ![shot.png](${API_BASE}/artifacts/0f8e4c2a)\n- [trace.zip](${API_BASE}/artifacts/1a2b3c4d)`)
  })
})

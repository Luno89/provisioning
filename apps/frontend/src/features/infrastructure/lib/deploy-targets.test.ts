import { describe, expect, it } from 'vitest'
import { deployableTo, targetLabel } from './deploy-targets'

describe('where an app can be deployed', () => {
  it('is a healthy cluster, or a machine\'s own at rest, which the deploy starts', () => {
    expect(deployableTo({ status: 'healthy', provider: 'k3d' })).toBe(true)
    expect(deployableTo({ status: 'stopped', provider: 'machine' })).toBe(true)
    expect(deployableTo({ status: 'healthy', provider: 'machine' })).toBe(true)
    expect(deployableTo({ status: 'provisioning', provider: 'hetzner' })).toBe(false)
    expect(deployableTo({ status: 'failed', provider: 'machine' })).toBe(false)
  })

  it('names a machine as the person\'s own and says a stopped one starts for the deploy', () => {
    expect(targetLabel({ name: 'desk', provider: 'machine', status: 'stopped' })).toBe('desk (my machine, started when this deploys)')
    expect(targetLabel({ name: 'desk', provider: 'machine', status: 'healthy' })).toBe('desk (my machine)')
    expect(targetLabel({ name: 'gpu', provider: 'k3d', status: 'healthy', gpuEnabled: true })).toBe('gpu (k3d • GPU)')
  })
})

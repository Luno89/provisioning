import { describe, expect, it } from 'vitest'
import { deployableTo, reportsGpu, targetLabel } from './deploy-targets'

describe('where an app can be deployed', () => {
  it('is a healthy cluster, or a machine\'s own at rest, which the deploy starts', () => {
    expect(deployableTo({ status: 'healthy', provider: 'machine' })).toBe(true)
    expect(deployableTo({ status: 'stopped', provider: 'machine' })).toBe(true)
    expect(deployableTo({ status: 'healthy', provider: 'pool' })).toBe(true)
    expect(deployableTo({ status: 'stopped', provider: 'pool' })).toBe(false)
    expect(deployableTo({ status: 'failed', provider: 'machine' })).toBe(false)
  })

  it('names a machine as the person\'s own and says a stopped one starts for the deploy', () => {
    expect(targetLabel({ name: 'desk', provider: 'machine', status: 'stopped' })).toBe('desk (my machine, started when this deploys)')
    expect(targetLabel({ name: 'desk', provider: 'machine', status: 'healthy' })).toBe('desk (my machine)')
    expect(targetLabel({ name: 'rig', provider: 'machine', status: 'healthy', capacity: { cpuCores: 8, ramGb: 32, gpuCount: 2 } })).toBe('rig (my machine • GPU)')
    expect(targetLabel({ name: 'gpu', provider: 'pool', status: 'healthy', capacity: { cpuCores: 8, ramGb: 32, gpuCount: 1 } })).toBe('gpu (pool • GPU)')
  })

  it('takes a GPU from what the cluster\'s nodes report, and none when they report none or nothing was read', () => {
    expect(reportsGpu({ capacity: { cpuCores: 8, ramGb: 32, gpuCount: 1 } })).toBe(true)
    expect(reportsGpu({ capacity: { cpuCores: 8, ramGb: 32, gpuCount: 0 } })).toBe(false)
    expect(reportsGpu({ capacity: { cpuCores: 8, ramGb: 32 } })).toBe(false)
    expect(reportsGpu({})).toBe(false)
  })
})

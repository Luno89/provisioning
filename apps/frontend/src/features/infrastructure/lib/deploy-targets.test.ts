import { describe, expect, it } from 'vitest'
import { deployableTo, reportsGpu, targetLabel } from './deploy-targets'

const RTX = { vendor: 'nvidia' as const, model: 'NVIDIA GeForce RTX 3090', memoryMiB: 24576, count: 2, runtime: true }

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
    expect(targetLabel({ name: 'rig', provider: 'machine', status: 'stopped', gpus: [RTX] })).toBe('rig (my machine, started when this deploys • 2 × NVIDIA GeForce RTX 3090)')
  })

  it('takes a GPU from what the machine reports, before anything has readied it, and none when it reports none or has not said', () => {
    expect(reportsGpu({ gpus: [RTX] })).toBe(true)
    expect(reportsGpu({ gpus: [] })).toBe(false)
    expect(reportsGpu({})).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { chosenGpus, gpuChoicesOf } from './gpu-choices'

const rig = { name: 'rig', provider: 'machine', gpus: [{ vendor: 'nvidia', model: 'RTX 3090', memoryMiB: 24576, count: 2, runtime: true }] }

describe('the GPUs a model server can be given on a machine', () => {
  it('offers each vendor the machine can use, from one up to what it has, and never CPU only', () => {
    expect(gpuChoicesOf(rig)).toEqual({ vendors: [{ vendor: 'nvidia', label: 'NVIDIA', counts: ['1', '2'] }] })
  })

  it('offers both vendors when the machine has both', () => {
    const both = { ...rig, gpus: [...rig.gpus, { vendor: 'amd', model: 'RX 7900 XTX', memoryMiB: 24576, count: 1, runtime: true }] }
    expect(gpuChoicesOf(both).vendors.map((vendor) => [vendor.vendor, vendor.counts])).toEqual([['nvidia', ['1', '2']], ['amd', ['1']]])
  })

  it('says why there is no GPU to give when the machine has not said, shows none, or cannot pass them to a pod', () => {
    expect(gpuChoicesOf({ name: 'rig', provider: 'machine' })).toEqual({ vendors: [], problem: 'rig has not said which GPUs it has: its agent is from before GPUs were reported, or it has not connected since. Once it connects with a current agent, it says. It cannot run there until then.' })
    expect(gpuChoicesOf({ name: 'rig', provider: 'machine', gpus: [], gpuProblems: ['nvidia-smi is installed but does not answer'] }).problem).toBe('rig shows no GPU: nvidia-smi is installed but does not answer. It cannot run there until then.')
    expect(gpuChoicesOf({ name: 'rig', provider: 'machine', gpus: [], gpuProblems: [] }).problem).toBe('rig shows no GPU: no NVIDIA or AMD GPU answers there, so apps there cannot be given one. It cannot run there until then.')
    const bare = [{ vendor: 'nvidia', device: 'GA102 [GeForce RTX 3090]', count: 1 }]
    expect(gpuChoicesOf({ name: 'rig', provider: 'machine', gpus: [], gpuProblems: [], gpusWithoutDriver: bare }).problem).toBe('rig has 1 × NVIDIA GA102 [GeForce RTX 3090] whose driver is not installed. It cannot run there until then.')
    expect(gpuChoicesOf({ name: 'rig', provider: 'machine', gpus: [{ vendor: 'amd', model: 'RX 7900 XTX', count: 1, runtime: true }], gpusWithoutDriver: bare }, { runsOn: ['nvidia'] }).problem).toBe('rig has 1 × NVIDIA GA102 [GeForce RTX 3090] whose driver is not installed. It cannot run there until then.')
    expect(gpuChoicesOf({ ...rig, gpus: [{ ...rig.gpus[0]!, runtime: false }] }).problem).toBe('rig has 2 NVIDIA GPUs, and pods there cannot be given them yet: NVIDIA\'s CDI support is not installed. Run the command from My Machines again on it, which offers to install it (the NVIDIA Container Toolkit). It cannot run there until then.')
    expect(gpuChoicesOf({ name: 'koala', provider: 'pool', gpus: rig.gpus }).problem).toBe('Only a machine\'s own cluster runs apps on GPUs, and koala is not one. It cannot run there until then.')
  })

  it('offers only NVIDIA for an app that runs only on NVIDIA, and says it cannot run without one', () => {
    const amd = { ...rig, gpus: [{ vendor: 'amd', model: 'RX 7900 XTX', memoryMiB: 24576, count: 1, runtime: true }] }
    expect(gpuChoicesOf(amd, { runsOn: ['nvidia'] })).toEqual({ vendors: [], problem: 'rig has no NVIDIA GPU (it has 1 × RX 7900 XTX). It cannot run there until then.' })
  })
})

describe('what is chosen when the machine changes under a choice', () => {
  const two = gpuChoicesOf(rig)
  it('keeps a choice the machine still offers, and never keeps CPU only', () => {
    expect(chosenGpus(two, { vendor: 'nvidia', count: '2' })).toEqual({ vendor: 'nvidia', count: '2' })
    expect(chosenGpus(two, { vendor: 'nvidia', count: '0' })).toEqual({ vendor: 'nvidia', count: '1' })
  })
  it('takes the machine\'s first vendor and one GPU for a choice it does not offer, and no count when it offers none', () => {
    expect(chosenGpus(two, { vendor: 'amd', count: '4' })).toEqual({ vendor: 'nvidia', count: '1' })
    expect(chosenGpus({ vendors: [], problem: 'none' }, { vendor: 'nvidia', count: '1' })).toEqual({ vendor: 'nvidia', count: '' })
  })
})

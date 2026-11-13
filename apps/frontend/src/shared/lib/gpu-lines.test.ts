import { describe, expect, it } from 'vitest'
import { gpuLines } from './gpu-lines'

const RTX = { vendor: 'nvidia' as const, model: 'NVIDIA GeForce RTX 3090', memoryMiB: 24576, count: 2, runtime: true }

describe('what a machine\'s card says about its GPUs', () => {
  it('names them with their memory, and says when k3s cannot pass them to a pod', () => {
    expect(gpuLines({ gpus: [RTX], gpuProblems: [] })).toEqual(['GPUs: 2 × NVIDIA GeForce RTX 3090, 24 GiB each'])
    expect(gpuLines({ gpus: [{ ...RTX, runtime: false }], gpuProblems: [] })).toEqual(['GPUs: 2 × NVIDIA GeForce RTX 3090, 24 GiB each, not usable yet: the NVIDIA Container Toolkit is not installed'])
  })

  it('says what kept the machine from reading them, and nothing for a machine that has not said', () => {
    expect(gpuLines({ gpus: [], gpuProblems: ['nvidia-smi is installed but does not answer'] })).toEqual(['GPUs could not be read: nvidia-smi is installed but does not answer'])
    expect(gpuLines({ gpus: [], gpuProblems: [] })).toEqual([])
    expect(gpuLines({})).toEqual([])
  })
})

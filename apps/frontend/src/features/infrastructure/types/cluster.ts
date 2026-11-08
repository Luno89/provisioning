
export type ClusterStatus =
  | 'provisioning'
  | 'healthy'
  | 'failed'
  | 'destroying'
  | 'discovered'
  | 'destroyed'
  | 'stopped'

export interface Cluster {
  id: string
  name: string
  provider: 'machine' | 'pool' | 'root'
  status: ClusterStatus
  capacity?: { cpuCores: number; ramGb: number; gpuCount?: number; gpuVendor?: 'nvidia' | 'amd' }
  createdAt?: string
  meshIp?: string
}

export interface ClusterPod {
  metadata?: {
    name?: string
    namespace?: string
    creationTimestamp?: string
  }
  status?: {
    phase?: string
    podIP?: string
  }
}

export interface GpuStatus {
  hasGpu?: boolean
  vendor?: string
  totalCapacity?: number
  totalAllocatable?: number
  totalAllocated?: number
  availableGpus?: number
  nodes?: {
    name?: string
    gpuCapacity?: number
    gpuAllocatable?: number
    nvidiaGpus?: number
    amdGpus?: number
  }[]
  devicePlugins?: {
    vendor?: string
    name?: string
    status?: string
    readyPods?: number
    desiredPods?: number
  }[]
  gpuPods?: {
    name?: string
    namespace?: string
    gpus?: number
    status?: string
  }[]
}

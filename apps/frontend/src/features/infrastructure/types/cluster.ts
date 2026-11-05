
export type ClusterStatus =
  | 'provisioning'
  | 'healthy'
  | 'failed'
  | 'destroying'
  | 'discovered'
  | 'destroyed'
  | 'starting'
  | 'stopped'

export interface Cluster {
  id: string
  name: string
  provider: 'k3d' | 'aws' | 'gcp' | 'azure' | 'do' | 'machine' | 'hetzner'
  status: ClusterStatus
  isSystem?: boolean
  gpuEnabled?: boolean
  createdAt?: string
  progress?: { stage?: string; message?: string }
  remoteHost?: string
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
  passthroughEnabled?: boolean
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

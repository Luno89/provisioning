/**
 * ── DUPLICATED, KNOWINGLY ──
 *
 * The authority is `ClusterMetadata` in `apps/backend/src/lib/types.ts`. If this disagrees with it,
 * the backend is right.
 *
 * It cannot be imported: `@koala/harness-types` is types-only by design and carries the harness
 * vocabulary, not the infrastructure one, and `ClusterMetadata` reaches for `ClusterProviderName`
 * and `ClusterProgress` which are runtime-adjacent. See `Lab/shared.ts` for the same note on the
 * harness side.
 *
 * This is narrower than the backend's on purpose — only the fields the UI renders. A field the
 * screen does not show should not appear here, or the type becomes a second copy of the record
 * rather than a description of what this screen needs.
 *
 * The FIRST domain type in this frontend. Before it there was no `Cluster`, `Deployment` or `User`
 * interface anywhere, and every one of the 122 axios call sites invented its shape inline or gave
 * up and said `any` — which is how `ClustersView` ended up typed `props: any`.
 */

/** Terminal and transitional states alike. See the long note on the backend union for why. */
export type ClusterStatus =
  | 'provisioning'
  | 'healthy'
  | 'failed'
  | 'destroying'
  | 'discovered'
  | 'destroyed'
  /** A bring-your-own machine whose generated public key has not been authorised yet. */
  | 'awaiting-key'

export interface Cluster {
  id: string
  name: string
  provider: string
  status: ClusterStatus
  /**
   * The always-on management cluster. It has no owner, is visible to everyone, and is read-only in
   * the UI — hence the separate styling and the missing destroy button.
   */
  isSystem?: boolean
  gpuEnabled?: boolean
  createdAt?: string
  /** What the provisioning workflow is currently doing, for the progress line. */
  progress?: { stage?: string; message?: string }
  /** Present on a bring-your-own cluster waiting for its key to be installed. */
  publicKey?: string
}

/**
 * One pod, as much of it as the cluster screen renders — a small subset of a real Kubernetes Pod.
 *
 * Narrow on purpose: widening it to the full object would invite the screen to reach for anything,
 * and the compiler names each field the moment one is actually needed. `creationTimestamp` and
 * `podIP` arrived exactly that way.
 */
export interface ClusterPod {
  metadata?: {
    name?: string
    namespace?: string
    /** Rendered as an age. ISO 8601 from the API server. */
    creationTimestamp?: string
  }
  status?: {
    phase?: string
    podIP?: string
  }
}

/** One Helm release, as `helm list` reports it. */
export interface HelmRelease {
  name?: string
  namespace?: string
  chart?: string
  status?: string
  revision?: string
  updated?: string
  /** Snake case because Helm's JSON output is, and this is passed through verbatim. */
  app_version?: string
}

/**
 * Written from a live `GET /api/clusters/:id/gpu-status` response rather than from the handler, so
 * the optionality reflects what actually arrives. The first draft was a guess and the compiler
 * caught four fields the screen renders that it did not have.
 */
export interface GpuStatus {
  hasGpu?: boolean
  vendor?: string
  /**
   * Whether the runtime can pass a device through at all. False on k3d, whose nested containerd
   * cannot — so a k3d cluster is never GPU-enabled however many cards the host has.
   */
  passthroughEnabled?: boolean
  totalCapacity?: number
  totalAllocatable?: number
  totalAllocated?: number
  /** Allocatable minus allocated. Zero with `hasGpu` true means every card is in use. */
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

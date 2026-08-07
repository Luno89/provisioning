/**
 * How much host RAM an inference deployment will actually take, and whether the node has it.
 *
 * ── WHY THIS EXISTS ──
 * The construct sized its own memory limit from the model, then floored it at 32G. On a 30 GiB
 * machine that is not a limit at all: Kubernetes will never evict the pod before the host starts
 * swapping, so the failure mode is the whole machine going unresponsive rather than one pod being
 * restarted. Measured live — 28 GiB of 30 in use, 244 MiB free, 8.6 GiB swapped, and a variant that
 * burned its full 15-minute timeout without completing a single turn.
 *
 * ── VRAM IS NOT THE QUESTION ──
 * A quantised model sized to fit two GPUs can still exhaust host RAM: the weights live on the GPU,
 * while CUDA contexts, tensor-parallel worker processes and staging buffers live here. The same
 * deployment measured 21.4 GiB of host RAM with inline loading on and 7.8 GiB with it off, with
 * identical VRAM either way.
 *
 * The numbers below are measured rather than derived, from a 19 GB Qwen3-27B exl3 across two RTX
 * 3090s. Treat them as calibration, not physics — which is why the plan reports what it assumed.
 */

/** Host RAM per GPU worker: a CUDA context, a Python interpreter, and its staging buffers. */
const PER_GPU_OVERHEAD_BYTES = 2.5e9;

/** The server process itself, independent of how many GPUs it drives. */
const BASE_OVERHEAD_BYTES = 3e9;

/**
 * What inline model loading costs, as a fraction of the weights.
 *
 * Measured at 13.6 GB extra for a 19 GB model — the loader keeps a host-side copy so a model can
 * be swapped without re-reading it. Worth paying only if you actually swap models; otherwise it is
 * the single largest line here and the first thing to turn off.
 */
const INLINE_LOADING_FRACTION = 0.75;

/** Long contexts enlarge host-side staging even though the KV cache itself is on the GPU. */
function seqLenFactor(maxSeqLen: number): number {
  if (maxSeqLen > 65536) return 1.5;
  if (maxSeqLen > 32768) return 1.25;
  return 1.0;
}

/**
 * Share of the node's allocatable memory one inference pod may claim.
 *
 * Not 100%: the node also runs the control plane, the ingress, whatever else is deployed, and —
 * on a workstation — a desktop session. A pod permitted the whole node is the situation this
 * module exists to prevent.
 */
const NODE_SHARE = 0.7;

export interface HostMemoryInputs {
  /** Total size of the weights on disk. Absent when the registry lookup failed. */
  modelBytes?: number | undefined;
  gpuCount: number;
  maxSeqLen: number;
  inlineModelLoading: boolean;
  /** The node's allocatable memory. Absent when the cluster could not be asked. */
  allocatableBytes?: number | undefined;
}

export interface HostMemoryPlan {
  /** What to set as the container's memory limit, in bytes. */
  limitBytes: number;
  /** Tensor-parallel staging happens through /dev/shm, sized per shard. */
  shmBytes: number;
  /** What the pod may claim, given the node. Absent when the node could not be measured. */
  budgetBytes?: number;
  /** Set when the deployment cannot fit — the caller should refuse rather than deploy it. */
  refusal?: string;
  /** What this plan assumed, so a wrong number is arguable rather than mysterious. */
  basis: string;
}

const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;

export function planHostMemory(input: HostMemoryInputs): HostMemoryPlan {
  const gpus = Math.max(input.gpuCount, 1);
  const factor = seqLenFactor(input.maxSeqLen);

  // Unknown model size is not a reason to guess low: an under-sized limit OOMKills the pod on
  // load, which looks like a broken image rather than a number someone chose.
  const modelBytes = input.modelBytes ?? 20e9;

  // Per shard: tensor parallelism divides the weights across workers by design, so each one's
  // staging footprint tracks its own shard rather than the whole model.
  const shmBytes = Math.max(4e9, (modelBytes / gpus) * 1.15);

  /**
   * `/dev/shm` is counted IN the limit, not beside it.
   *
   * Shared memory is tmpfs, and tmpfs pages are charged to the cgroup that faults them — so a
   * container given a 20G limit and a 16Gi shm mount can be OOMKilled by its own staging buffers
   * while the process itself is nowhere near the ceiling. Measured the hard way: a limit computed
   * without this killed the model server mid-experiment at exit 137, with `free` showing 5 GiB
   * resident in shared memory.
   */
  const required =
    (BASE_OVERHEAD_BYTES + PER_GPU_OVERHEAD_BYTES * gpus) * factor
    + (input.inlineModelLoading ? modelBytes * INLINE_LOADING_FRACTION : 0)
    + shmBytes;

  const basis =
    `${gib(modelBytes)} of weights${input.modelBytes ? '' : ' (assumed — size lookup failed)'}, `
    + `${gpus} GPU${gpus > 1 ? 's' : ''}, seq len ${input.maxSeqLen}, `
    + `inline loading ${input.inlineModelLoading ? 'on' : 'off'}`;

  if (input.allocatableBytes === undefined) {
    // No node reading means no clamp — but also no false confidence. The estimate still beats a
    // flat floor, and the caller can say the check did not happen.
    return { limitBytes: Math.ceil(required), shmBytes: Math.ceil(shmBytes), basis };
  }

  const budgetBytes = input.allocatableBytes * NODE_SHARE;
  if (required > budgetBytes) {
    return {
      limitBytes: Math.ceil(required),
      shmBytes: Math.ceil(shmBytes),
      budgetBytes,
      basis,
      // Both numbers and both levers, because "it does not fit" without them is a dead end.
      refusal:
        `This deployment needs about ${gib(required)} of host RAM but only ${gib(budgetBytes)} `
        + `is available on the node (${gib(input.allocatableBytes)} allocatable, `
        + `${Math.round(NODE_SHARE * 100)}% usable by one app). Basis: ${basis}. `
        + (input.inlineModelLoading
          ? 'Turning off inline model loading is the largest single saving.'
          : 'Reduce the sequence length, use fewer GPUs, or pick a smaller quantisation.'),
    };
  }

  return { limitBytes: Math.ceil(required), shmBytes: Math.ceil(shmBytes), budgetBytes, basis };
}

/** Parses a Kubernetes quantity (`32800000Ki`, `30Gi`, `8G`, plain bytes) into bytes. */
export function parseQuantity(value: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)([EPTGMK]i?)?$/.exec(value.trim());
  if (!m) return undefined;
  const n = parseFloat(m[1]!);
  const scale: Record<string, number> = {
    Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, Pi: 1024 ** 5, Ei: 1024 ** 6,
    K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18,
  };
  return m[2] ? n * (scale[m[2]] ?? 1) : n;
}


const PER_GPU_OVERHEAD_BYTES = 2.5e9;

const BASE_OVERHEAD_BYTES = 3e9;

const INLINE_LOADING_FRACTION = 0.75;

function seqLenFactor(maxSeqLen: number): number {
  if (maxSeqLen > 65536) return 1.5;
  if (maxSeqLen > 32768) return 1.25;
  return 1.0;
}

const NODE_SHARE = 0.7;

export interface HostMemoryInputs {
  modelBytes?: number | undefined;
  gpuCount: number;
  maxSeqLen: number;
  inlineModelLoading: boolean;
  allocatableBytes?: number | undefined;
}

export interface HostMemoryPlan {
  limitBytes: number;
  shmBytes: number;
  budgetBytes?: number;
  refusal?: string;
  basis: string;
}

const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;

export function planHostMemory(input: HostMemoryInputs): HostMemoryPlan {
  const gpus = Math.max(input.gpuCount, 1);
  const factor = seqLenFactor(input.maxSeqLen);

  const modelBytes = input.modelBytes || 20e9;

  const shmBytes = Math.max(4e9, (modelBytes / gpus) * 1.15);

  const required =
    (BASE_OVERHEAD_BYTES + PER_GPU_OVERHEAD_BYTES * gpus) * factor
    + (input.inlineModelLoading ? modelBytes * INLINE_LOADING_FRACTION : 0)
    + shmBytes;

  const basis =
    `${gib(modelBytes)} of weights${input.modelBytes ? '' : ' (assumed — size lookup failed)'}, `
    + `${gpus} GPU${gpus > 1 ? 's' : ''}, seq len ${input.maxSeqLen}, `
    + `inline loading ${input.inlineModelLoading ? 'on' : 'off'}`;

  if (input.allocatableBytes === undefined) {
    return { limitBytes: Math.ceil(required), shmBytes: Math.ceil(shmBytes), basis };
  }

  const budgetBytes = input.allocatableBytes * NODE_SHARE;
  if (required > budgetBytes) {
    return {
      limitBytes: Math.ceil(required),
      shmBytes: Math.ceil(shmBytes),
      budgetBytes,
      basis,
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

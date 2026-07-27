/**
 * A provider-neutral VPS offer.
 *
 * Every provider describes machines differently — Linode nests price under `price.monthly` and
 * sizes RAM in MB, Vultr uses `monthly_cost` and exposes bandwidth, Hetzner prices per-location and
 * splits VAT into net/gross. Adapters normalise all of that into this one shape so the UI can
 * filter and sort across providers without knowing any of it.
 *
 * Fields exist here because they change a real buying decision, not because a provider happened to
 * return them — see the notes on `arch`, `bandwidthTb`, `hourlyBilling` and `provisionable`, each
 * of which corresponds to a mistake that is easy to make otherwise.
 */

export type VpsArch = 'x86' | 'arm' | 'unknown';
export type VpsCpuType = 'shared' | 'dedicated' | 'unknown';

export interface VpsOffer {
  /** Stable key for the UI: `<provider>:<planId>`. */
  readonly id: string;
  readonly provider: string;
  /** Provider's own plan identifier — what you'd pass to Terraform. */
  readonly planId: string;
  readonly label: string;

  readonly vcpu: number;
  readonly cpuType: VpsCpuType;
  readonly cpuVendor?: string;
  /**
   * ARM plans are usually the cheapest per GB and are a trap for anything shipping x86-only
   * images — a Palworld/SteamCMD container will not run on one. Surfaced so it can be filtered.
   */
  readonly arch: VpsArch;

  /** System RAM available to the OS. Never GPU VRAM — see gpuVramGb. */
  readonly ramGb: number;
  readonly diskGb: number;
  readonly diskType?: string;

  /**
   * GPU attachment, kept strictly separate from ramGb. Conflating the two is easy and expensive:
   * a Vultr `vcg-a40-96c-480g-192vram` has 480GB of system RAM and 192GB of VRAM, and treating
   * either number as the other gives a wildly wrong price-per-GB and a wildly wrong machine.
   *
   * Coverage differs by provider — Scaleway reports VRAM structurally, Linode reports only a
   * count, and Vultr encodes VRAM in the plan id alone. `undefined` means "not reported", never
   * "zero".
   */
  readonly gpuCount?: number;
  readonly gpuVramGb?: number;
  readonly gpuModel?: string;

  /**
   * Included egress. Frequently the largest hidden cost difference between providers: Hetzner
   * bundles ~20TB, while metered clouds bill egress separately and a busy server can cost more in
   * bandwidth than in compute. `undefined` means the provider didn't say.
   */
  readonly bandwidthTb?: number;

  readonly priceMonthly: number;
  readonly priceHourly?: number;
  readonly currency: string;
  /**
   * Whether the price is before tax. Hetzner quotes both net and gross; US providers quote
   * pre-tax. Comparing a gross price against a net one silently overstates by ~19%, so the
   * normalised value is always NET and this records it.
   */
  readonly taxIncluded: boolean;

  /**
   * True when the provider bills by the hour. Decisive for this platform specifically: clusters
   * here are created and destroyed on demand, so a monthly-minimum provider charges a full month
   * for a ten-minute test.
   */
  readonly hourlyBilling: boolean;

  /** Provider-native location codes (e.g. `us-east`, `fsn1`, `ewr`). */
  readonly locations: readonly string[];

  /**
   * Whether THIS platform can actually provision it — i.e. a ProvisionClusterActivity branch and
   * CDKTF construct exist. Offers from providers we can only *price* are still worth showing for
   * comparison, but the UI must not offer a Deploy button for them.
   */
  readonly provisionable: boolean;

  /** Derived, and the most useful sort key when shopping on RAM. */
  readonly pricePerGbRam: number;
  /**
   * Derived, GPU plans only. The analogue of pricePerGbRam for accelerators, and the number that
   * actually decides a GPU purchase here — VRAM is what determines whether a model fits at all.
   *
   * Deliberately per GB of VRAM rather than per card: Vultr publishes no card count (only total
   * VRAM in the plan id), so a per-card figure would be fabricated for most of the GPU catalogue.
   * `undefined` when VRAM is unknown, never 0.
   */
  readonly pricePerGbVram?: number;
}

/** Any signal that a plan carries an accelerator — providers publish different subsets. */
export function offerHasGpu(o: Pick<VpsOffer, 'gpuCount' | 'gpuVramGb' | 'gpuModel'>): boolean {
  return Boolean((o.gpuCount && o.gpuCount > 0) || o.gpuVramGb || o.gpuModel);
}

export type VpsSortKey =
  | 'price' | 'pricePerGbRam' | 'ram' | 'vcpu' | 'disk' | 'bandwidth' | 'name' | 'gpu'
  | 'pricePerGbVram';

/**
 * The direction each column should take on its FIRST click. Nobody wants "sort by RAM" to lead
 * with the 512MB plans, or "sort by price" to lead with the most expensive.
 */
export const NATURAL_SORT_DIR: Record<VpsSortKey, 'asc' | 'desc'> = {
  price: 'asc',
  pricePerGbRam: 'asc',
  ram: 'desc',
  vcpu: 'desc',
  disk: 'desc',
  bandwidth: 'desc',
  name: 'asc',
  gpu: 'desc',
  pricePerGbVram: 'asc',
};

export interface VpsCatalogFilters {
  minRamGb?: number;
  maxRamGb?: number;
  minVcpu?: number;
  minDiskGb?: number;
  maxPriceMonthly?: number;
  /** Match against provider-native location codes, case-insensitive substring. */
  location?: string;
  arch?: VpsArch;
  cpuType?: VpsCpuType;
  /** true = GPU plans only, false = exclude them. Omitted leaves both in. */
  hasGpu?: boolean;
  minGpuVramGb?: number;
  provider?: string;
  /** Only offers this platform can actually deploy to. */
  provisionableOnly?: boolean;
  /** Only providers that bill hourly — relevant for short-lived clusters. */
  hourlyOnly?: boolean;
  sort?: VpsSortKey;
  /**
   * Omitted means "whatever reads naturally for this column" — cheapest-first for prices,
   * biggest-first for capacities. See NATURAL_SORT_DIR.
   */
  sortDir?: 'asc' | 'desc';
  limit?: number;
}

export interface VpsCatalogResult {
  offers: VpsOffer[];
  /** Per-provider fetch outcome, so the UI can say *why* a provider is missing. */
  sources: VpsCatalogSource[];
  fetchedAt: string;
}

export interface VpsCatalogSource {
  provider: string;
  status: 'ok' | 'no-credentials' | 'error';
  offerCount: number;
  /** Present when status is 'error'; also used to explain a credential requirement. */
  message?: string;
  /** Whether this provider's catalogue needs the user's API token. */
  requiresCredentials: boolean;
  cached: boolean;
}

/**
 * One provider's catalogue adapter.
 *
 * `fetch` receives the user's decrypted API token when the platform has one and the provider needs
 * it; public catalogues ignore it.
 */
export interface VpsCatalogAdapter {
  readonly provider: string;
  readonly requiresCredentials: boolean;
  /** True when a ProvisionClusterActivity branch exists for this provider. */
  readonly provisionable: boolean;
  fetch(token?: string): Promise<VpsOffer[]>;
}

/** Shared helper so every adapter derives this the same way. */
export function withDerived(
  offer: Omit<VpsOffer, 'id' | 'pricePerGbRam' | 'pricePerGbVram'>,
): VpsOffer {
  return {
    ...offer,
    id: `${offer.provider}:${offer.planId}`,
    // Guard against a 0-RAM plan (Vultr lists some bare-metal/GPU oddities) producing Infinity.
    pricePerGbRam: offer.ramGb > 0 ? offer.priceMonthly / offer.ramGb : 0,
    ...(offer.gpuVramGb && offer.gpuVramGb > 0
      ? { pricePerGbVram: offer.priceMonthly / offer.gpuVramGb }
      : {}),
  };
}

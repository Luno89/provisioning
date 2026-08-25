/**
 * Cluster providers as DATA — the same move `app-spec.ts` made for deployable apps.
 *
 * ── WHY ──
 * `ClusterWizard.tsx` carried the provider list AND the behaviour branches keyed on name equality:
 * `provider === 'hetzner'` meant "fetch a price catalog and pick plan+location", `=== 'remote'`
 * meant "pick a mesh machine". Adding a vendor meant editing component internals. The list below is
 * the data half of replacing those branches with capabilities; a new catalog-bearing vendor is a
 * row, not a code change.
 *
 * ── SEEDING CONTRACT ──
 * The repo carries the seeds (`BUILT_IN_PROVIDERS`); the database is the runtime source — seeded on
 * boot by `index.ts` exactly like app specs, idempotently and conservatively:
 *
 *   - a provider in the DB that we also ship: LEFT ALONE (the user may have edited it)
 *   - a provider only in the DB: left alone (it may have been disabled or retired on purpose)
 *   - a built-in missing from the DB: offered for seeding
 *
 * Failure to seed is logged, never fatal — a fresh install still provisions on k3d.
 */

export interface ClusterProviderSpec {
  /** Stable identifier used in API payloads and the wizard's select. */
  value: string;
  label: string;
  hint?: string;
  /** Credential provider key this provider needs stored, if any (see api/credentials). */
  credentialKey?: string;
  /** Serves a priced plan/location catalog (the hetzner-shaped flow). */
  hasCatalog: boolean;
  /** Attaches machines from the Headscale mesh rather than creating them. */
  usesMesh: boolean;
}

export const BUILT_IN_PROVIDERS: ClusterProviderSpec[] = [
  {
    value: 'k3d',
    label: 'Local Datacenter (k3d)',
    hint: 'Runs on this machine. No credentials, no cost.',
    hasCatalog: false,
    usesMesh: false,
  },
  {
    value: 'hetzner',
    label: 'Hetzner Cloud (VPS)',
    credentialKey: 'hetzner',
    hint: 'Creates a real VM, installs k3s on it over SSH, and bills to your Hetzner project.',
    hasCatalog: true,
    usesMesh: false,
  },
  {
    value: 'remote',
    label: 'One of my machines',
    hint: 'Use hardware you already own — a GPU workstation, a spare server — once it has joined the mesh under My Machines.',
    hasCatalog: false,
    usesMesh: true,
  },
];

/**
 * Which built-ins still need writing, given what is already stored.
 *
 * Matches on `value`, not deep equality: an edited built-in is DONE seeding, not out of date.
 */
export function providersToSeed(stored: ClusterProviderSpec[]): ClusterProviderSpec[] {
  const present = new Set(stored.map((p) => p.value));
  return BUILT_IN_PROVIDERS.filter((p) => !present.has(p.value));
}

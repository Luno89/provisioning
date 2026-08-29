
export interface ClusterProviderSpec {
  value: string;
  label: string;
  hint?: string;
  credentialKey?: string;
  hasCatalog: boolean;
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

export function providersToSeed(stored: ClusterProviderSpec[]): ClusterProviderSpec[] {
  const present = new Set(stored.map((p) => p.value));
  return BUILT_IN_PROVIDERS.filter((p) => !present.has(p.value));
}

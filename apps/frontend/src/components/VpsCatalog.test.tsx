import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import VpsCatalog from './VpsCatalog';
import * as vpsApi from '../api/vps-catalog';

/**
 * Mocked at the API module, not at axios.
 *
 * `vi.mock('axios')` does not touch the instance `api/client` builds with `axios.create()`, so a
 * URL-matching stub simply never fires once a component goes through the api layer — an empty
 * render rather than a mocking error. This says what the SERVER returns and knows no URLs.
 */
vi.mock('../api/vps-catalog', async (importOriginal) => ({
  ...(await importOriginal<typeof vpsApi>()),
  getVpsCatalog: vi.fn(),
  refreshVpsCatalog: vi.fn(),
}));

/**
 * Covers the GPU / VRAM cell specifically.
 *
 * Two consecutive bugs shipped here and both were caught by eye rather than by a test: first the
 * cell was keyed on `o.gpuCount`, which blanked Vultr's entire GPU line because Vultr publishes
 * VRAM and a brand but never a card count; then Scaleway's per-card VRAM was read as a total. The
 * providers genuinely disagree about which GPU fields exist, so the fixtures below are the real
 * shapes rather than one invented one.
 */

const base = {
  vcpu: 2, cpuType: 'shared', arch: 'x86',
  diskGb: 80, priceMonthly: 20, currency: 'USD', taxIncluded: false,
  hourlyBilling: true, locations: ['us-east'], provisionable: false,
  pricePerGbRam: 5,
};

// Vultr: VRAM + brand, NO card count. The exact shape that rendered blank.
const vultrGpu = {
  ...base, id: 'vultr:vcg-a16-2c-8g-2vram', provider: 'vultr', planId: 'vcg-a16-2c-8g-2vram',
  label: 'vcg-a16', ramGb: 8, gpuVramGb: 2, gpuModel: 'NVIDIA', pricePerGbVram: 45,
};
// Scaleway: count AND total VRAM.
const scalewayGpu = {
  ...base, id: 'scaleway:L4-2-24G', provider: 'scaleway', planId: 'L4-2-24G',
  label: 'L4-2-24G', ramGb: 96, gpuCount: 2, gpuVramGb: 48, gpuModel: 'NVIDIA L4',
  pricePerGbVram: 15,
};
// Linode: card count only, VRAM never published.
const linodeGpu = {
  ...base, id: 'linode:g1-gpu-rtx6000-4', provider: 'linode', planId: 'g1-gpu-rtx6000-4',
  label: 'RTX6000 x4', ramGb: 128, gpuCount: 4,
};
const cpuOnly = {
  ...base, id: 'linode:g6-standard-2', provider: 'linode', planId: 'g6-standard-2',
  label: 'Linode 4GB', ramGb: 4,
};

const renderWith = (offers: unknown[], onDeploy?: (o: any) => void) => {
  vi.mocked(vpsApi.getVpsCatalog).mockResolvedValue({
    offers,
    sources: [{ provider: 'vultr', status: 'ok', offerCount: offers.length, requiresCredentials: false, cached: false }],
    fetchedAt: new Date().toISOString(),
  } as never);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <VpsCatalog {...(onDeploy ? { onDeploy } : {})} />
    </QueryClientProvider>,
  );
};

/** The GPU / VRAM cell for a given plan id — 4th column of that plan's row. */
const gpuCell = (planId: string) => {
  const row = screen.getByText(planId).closest('tr');
  expect(row).not.toBeNull();
  return row!.querySelectorAll('td')[3]!;
};

describe('VpsCatalog GPU / VRAM cell', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('renders VRAM when the provider publishes no card count (Vultr)', async () => {
    renderWith([vultrGpu]);
    await waitFor(() => expect(screen.getByText('vcg-a16-2c-8g-2vram')).toBeDefined());
    const cell = gpuCell('vcg-a16-2c-8g-2vram');
    // Regression: this cell rendered "—" for all 26 Vultr GPU plans.
    expect(cell.textContent).toContain('2 GB');
    expect(cell.textContent).toContain('NVIDIA');
    expect(cell.textContent).not.toContain('—');
  });

  it('renders total VRAM and the card count when both are known (Scaleway)', async () => {
    renderWith([scalewayGpu]);
    await waitFor(() => expect(screen.getByText('L4-2-24G')).toBeDefined());
    const cell = gpuCell('L4-2-24G');
    expect(cell.textContent).toContain('48 GB');
    expect(cell.textContent).toContain('2×');
    expect(cell.textContent).toContain('NVIDIA L4');
  });

  it('falls back to the card count when VRAM is unpublished (Linode)', async () => {
    renderWith([linodeGpu]);
    await waitFor(() => expect(screen.getByText('g1-gpu-rtx6000-4')).toBeDefined());
    const cell = gpuCell('g1-gpu-rtx6000-4');
    expect(cell.textContent).toContain('4×');
    expect(cell.textContent).not.toContain('GB');
  });

  it('shows a dash for CPU-only plans, in both the GPU and per-GB-VRAM columns', async () => {
    renderWith([cpuOnly]);
    await waitFor(() => expect(screen.getByText('g6-standard-2')).toBeDefined());
    expect(gpuCell('g6-standard-2').textContent).toBe('—');
    const row = screen.getByText('g6-standard-2').closest('tr')!;
    expect(row.querySelectorAll('td')[7]!.textContent).toBe('—');
  });

  it('renders sub-cent hourly rates without rounding them to zero', async () => {
    // Vultr's cheapest plan is $0.003/hr. Two decimals would render "$0.00" and make the whole
    // column useless for exactly the plans a short-lived cluster would pick.
    renderWith([{ ...cpuOnly, priceHourly: 0.003 }]);
    await waitFor(() => expect(screen.getByText('g6-standard-2')).toBeDefined());
    const row = screen.getByText('g6-standard-2').closest('tr')!;
    expect(row.querySelectorAll('td')[8]!.textContent).toBe('$0.0030');
  });

  it('drops to two decimals for hourly rates above a dollar', async () => {
    renderWith([{ ...scalewayGpu, priceHourly: 3.5 }]);
    await waitFor(() => expect(screen.getByText('L4-2-24G')).toBeDefined());
    const row = screen.getByText('L4-2-24G').closest('tr')!;
    expect(row.querySelectorAll('td')[8]!.textContent).toBe('$3.50');
  });

  it('shows a dash when a provider publishes no hourly rate', async () => {
    renderWith([cpuOnly]);
    await waitFor(() => expect(screen.getByText('g6-standard-2')).toBeDefined());
    const row = screen.getByText('g6-standard-2').closest('tr')!;
    expect(row.querySelectorAll('td')[8]!.textContent).toBe('—');
  });

  it('keeps system RAM out of the GPU column', async () => {
    // The costly conflation: Scaleway's L4-2-24G has 96GB of RAM and 48GB of VRAM. Showing either
    // number in the other column gives a wildly wrong machine and a wildly wrong price per GB.
    renderWith([scalewayGpu]);
    await waitFor(() => expect(screen.getByText('L4-2-24G')).toBeDefined());
    const row = screen.getByText('L4-2-24G').closest('tr')!;
    expect(row.querySelectorAll('td')[2]!.textContent).toBe('96 GB');
    expect(gpuCell('L4-2-24G').textContent).not.toContain('96');
  });
});

describe('Deploy button', () => {
  beforeEach(() => vi.clearAllMocks());

  const deployable = { ...cpuOnly, provider: 'hetzner', planId: 'cx33', id: 'hetzner:cx33@fsn1', provisionable: true, locations: ['fsn1', 'hel1'] };

  const deployBtn = (planId: string) =>
    screen.getByText(planId).closest('tr')!.querySelector('button');

  it('offers Deploy only on provisionable rows', async () => {
    renderWith([deployable, cpuOnly], vi.fn());
    await waitFor(() => expect(screen.getByText('cx33')).toBeDefined());
    expect(deployBtn('cx33')?.textContent).toBe('Deploy');
    // A Deploy button on a priced-but-undeployable provider would be a promise we cannot keep.
    expect(deployBtn('g6-standard-2')).toBeNull();
  });

  it('passes the row\'s own location, not the plan\'s cheapest', async () => {
    // The row exists separately precisely because its price is specific to these locations —
    // handing the wizard a different one would provision at a price the user never saw.
    const onDeploy = vi.fn();
    renderWith([deployable], onDeploy);
    await waitFor(() => expect(screen.getByText('cx33')).toBeDefined());
    deployBtn('cx33')!.click();
    expect(onDeploy).toHaveBeenCalledWith({ provider: 'hetzner', planId: 'cx33', location: 'fsn1' });
  });

  it('renders no Deploy column content when the host provides no handler', async () => {
    renderWith([deployable]);
    await waitFor(() => expect(screen.getByText('cx33')).toBeDefined());
    expect(deployBtn('cx33')).toBeNull();
  });
});

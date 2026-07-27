import { describe, it, expect } from 'vitest';
import { applyFilters } from './VpsCatalogService.js';
import { withDerived } from '../lib/vps-catalog/types.js';
import type { VpsOffer } from '../lib/vps-catalog/types.js';

const offer = (o: Partial<Parameters<typeof withDerived>[0]> = {}): VpsOffer =>
  withDerived({
    provider: 'test', planId: 'p1', label: 'P1',
    vcpu: 2, cpuType: 'shared', arch: 'x86',
    ramGb: 4, diskGb: 80,
    priceMonthly: 20, currency: 'USD', taxIncluded: false,
    hourlyBilling: true, locations: ['us-east'], provisionable: false,
    ...o,
  } as any);

describe('applyFilters', () => {
  it('filters on the resource dimensions', () => {
    const all = [offer({ ramGb: 2 }), offer({ ramGb: 8 }), offer({ ramGb: 32 })];
    expect(applyFilters(all, { minRamGb: 8 })).toHaveLength(2);
    expect(applyFilters(all, { minRamGb: 8, maxRamGb: 8 })).toHaveLength(1);
    expect(applyFilters([offer({ vcpu: 1 }), offer({ vcpu: 8 })], { minVcpu: 4 })).toHaveLength(1);
    expect(applyFilters([offer({ diskGb: 20 }), offer({ diskGb: 500 })], { minDiskGb: 100 })).toHaveLength(1);
    expect(applyFilters([offer({ priceMonthly: 5 }), offer({ priceMonthly: 200 })], { maxPriceMonthly: 50 })).toHaveLength(1);
  });

  it('filters ARM out when x86 is required', () => {
    // The Palworld lesson: an ARM plan is often the cheapest per GB and silently cannot run an
    // x86-only image, so this filter has to be exact rather than a hint.
    const all = [offer({ arch: 'arm', priceMonthly: 5 }), offer({ arch: 'x86', priceMonthly: 50 })];
    const out = applyFilters(all, { arch: 'x86' });
    expect(out).toHaveLength(1);
    expect(out[0]!.arch).toBe('x86');
  });

  it('filters on cpuType, provider, hourly billing and provisionability', () => {
    const all = [
      offer({ provider: 'a', cpuType: 'shared', hourlyBilling: true, provisionable: true }),
      offer({ provider: 'b', cpuType: 'dedicated', hourlyBilling: false, provisionable: false }),
    ];
    expect(applyFilters(all, { cpuType: 'dedicated' })).toHaveLength(1);
    expect(applyFilters(all, { provider: 'a' })).toHaveLength(1);
    expect(applyFilters(all, { hourlyOnly: true })).toHaveLength(1);
    expect(applyFilters(all, { provisionableOnly: true })).toHaveLength(1);
  });

  it('matches locations case-insensitively by substring', () => {
    const all = [offer({ locations: ['us-east', 'eu-west'] }), offer({ locations: ['ap-south'] })];
    expect(applyFilters(all, { location: 'EU' })).toHaveLength(1);
  });

  it('treats an offer with no locations as globally available', () => {
    // Linode prices plans globally and returns no per-plan location list. Excluding those from a
    // location search would hide the entire provider.
    const all = [offer({ locations: [] })];
    expect(applyFilters(all, { location: 'us-east' })).toHaveLength(1);
  });

  it('defaults to sorting by price per GB of RAM', () => {
    const cheapTotal = offer({ planId: 'small', ramGb: 2, priceMonthly: 10 }); // 5.00/GB
    const betterValue = offer({ planId: 'big', ramGb: 32, priceMonthly: 100 }); // 3.13/GB
    const out = applyFilters([cheapTotal, betterValue], {});
    expect(out[0]!.planId).toBe('big');
  });

  it('sorts by absolute price when asked', () => {
    const out = applyFilters(
      [offer({ planId: 'big', ramGb: 32, priceMonthly: 100 }), offer({ planId: 'small', ramGb: 2, priceMonthly: 10 })],
      { sort: 'price' },
    );
    expect(out[0]!.planId).toBe('small');
  });

  it('applies the limit after sorting, not before', () => {
    const all = [
      offer({ planId: 'a', ramGb: 2, priceMonthly: 20 }),  // 10/GB
      offer({ planId: 'b', ramGb: 8, priceMonthly: 20 }),  // 2.5/GB
      offer({ planId: 'c', ramGb: 4, priceMonthly: 20 }),  // 5/GB
    ];
    expect(applyFilters(all, { limit: 1 })[0]!.planId).toBe('b');
  });
});

describe('column sorting', () => {
  it('uses a natural direction per column when none is given', () => {
    const small = offer({ planId: 'small', ramGb: 2, priceMonthly: 5 });
    const big = offer({ planId: 'big', ramGb: 64, priceMonthly: 500 });
    // Price ascends (cheapest first); capacities descend (biggest first). Nobody wants "sort by
    // RAM" to lead with the 512MB plans.
    expect(applyFilters([big, small], { sort: 'price' })[0]!.planId).toBe('small');
    expect(applyFilters([small, big], { sort: 'ram' })[0]!.planId).toBe('big');
    expect(applyFilters([small, big], { sort: 'vcpu', ...{} })).toHaveLength(2);
  });

  it('honours an explicit direction', () => {
    const a = offer({ planId: 'a', priceMonthly: 5 });
    const b = offer({ planId: 'b', priceMonthly: 500 });
    expect(applyFilters([a, b], { sort: 'price', sortDir: 'desc' })[0]!.planId).toBe('b');
    expect(applyFilters([a, b], { sort: 'ram', sortDir: 'asc' })).toHaveLength(2);
  });

  it('sinks unknown disk to the bottom in BOTH directions', () => {
    // diskGb 0 means "the provider didn't tell us" (Vultr's VX family). Ascending by disk must
    // not fill the top of the table with rows that render "—".
    const known = offer({ planId: 'known', diskGb: 100 });
    const unknown = offer({ planId: 'unknown', diskGb: 0 });
    expect(applyFilters([unknown, known], { sort: 'disk', sortDir: 'asc' })[0]!.planId).toBe('known');
    expect(applyFilters([unknown, known], { sort: 'disk', sortDir: 'desc' })[0]!.planId).toBe('known');
  });

  it('sinks missing bandwidth to the bottom in both directions', () => {
    const known = offer({ planId: 'known', bandwidthTb: 2 } as any);
    const missing = offer({ planId: 'missing' });
    expect(applyFilters([missing, known], { sort: 'bandwidth', sortDir: 'asc' })[0]!.planId).toBe('known');
    expect(applyFilters([missing, known], { sort: 'bandwidth', sortDir: 'desc' })[0]!.planId).toBe('known');
  });

  it('groups by provider when sorting by name', () => {
    const out = applyFilters(
      [offer({ provider: 'vultr', planId: 'a' }), offer({ provider: 'linode', planId: 'z' })],
      { sort: 'name' },
    );
    expect(out.map((o) => o.provider)).toEqual(['linode', 'vultr']);
  });

  it('breaks ties stably so equal rows do not reshuffle', () => {
    const a = offer({ provider: 'p', planId: 'aaa', priceMonthly: 10, ramGb: 4 });
    const b = offer({ provider: 'p', planId: 'bbb', priceMonthly: 10, ramGb: 4 });
    const first = applyFilters([b, a], { sort: 'price' }).map((o) => o.id);
    const second = applyFilters([a, b], { sort: 'price' }).map((o) => o.id);
    expect(first).toEqual(second);
  });
});

describe('GPU is kept separate from system RAM', () => {
  // A Vultr vcg-a40-96c-480g-192vram genuinely has 480GB of system RAM and 192GB of VRAM.
  // Conflating them gives both a wildly wrong price-per-GB and a wildly wrong machine.
  const gpuBox = offer({ planId: 'gpu', ramGb: 480, priceMonthly: 2000, gpuCount: 1, gpuVramGb: 192 } as any);
  const plainBox = offer({ planId: 'plain', ramGb: 32, priceMonthly: 100 });

  it('prices per GB against system RAM, not VRAM', () => {
    expect(gpuBox.pricePerGbRam).toBeCloseTo(2000 / 480, 4);
  });

  it('hasGpu:false excludes GPU plans, which is the common case', () => {
    const out = applyFilters([gpuBox, plainBox], { hasGpu: false });
    expect(out.map((o) => o.planId)).toEqual(['plain']);
  });

  it('hasGpu:true keeps only GPU plans', () => {
    expect(applyFilters([gpuBox, plainBox], { hasGpu: true }).map((o) => o.planId)).toEqual(['gpu']);
  });

  it('omitting hasGpu leaves both in — false must not be read as "unset"', () => {
    expect(applyFilters([gpuBox, plainBox], {})).toHaveLength(2);
  });

  it('filters on minimum VRAM, excluding plans with no GPU at all', () => {
    const small = offer({ planId: 'small-gpu', gpuCount: 1, gpuVramGb: 16 } as any);
    const out = applyFilters([gpuBox, small, plainBox], { minGpuVramGb: 24 });
    expect(out.map((o) => o.planId)).toEqual(['gpu']);
  });

  it('sorts by VRAM, falling back to card count where VRAM is unpublished', () => {
    // Linode reports a GPU count but never VRAM, so those plans must still order sensibly
    // rather than sinking as "unknown".
    const noVram = offer({ planId: 'linode-gpu', gpuCount: 4 } as any);
    const out = applyFilters([noVram, gpuBox, plainBox], { sort: 'gpu' });
    expect(out.map((o) => o.planId)).toEqual(['gpu', 'linode-gpu', 'plain']);
  });
});

describe('withDerived', () => {
  it('computes price per GB and a namespaced id', () => {
    const o = offer({ provider: 'hetzner', planId: 'cx53', ramGb: 32, priceMonthly: 22.49 });
    expect(o.id).toBe('hetzner:cx53');
    expect(o.pricePerGbRam).toBeCloseTo(0.703, 3);
  });

  it('does not divide by zero on a 0-RAM plan', () => {
    // Vultr lists bare-metal/GPU entries whose RAM field is absent; Infinity would sort them to
    // the bottom of every list and render as garbage.
    expect(offer({ ramGb: 0 }).pricePerGbRam).toBe(0);
  });
});

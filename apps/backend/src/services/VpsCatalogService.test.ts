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

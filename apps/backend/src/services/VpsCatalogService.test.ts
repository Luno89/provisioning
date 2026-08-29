import { describe, it, expect } from 'vitest';
import { applyFilters, VpsCatalogService } from './VpsCatalogService.js';
import { withDerived } from '../lib/vps-catalog/types.js';
import type { VpsCatalogAdapter, VpsOffer } from '../lib/vps-catalog/types.js';

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
    const all = [offer({ locations: [] })];
    expect(applyFilters(all, { location: 'us-east' })).toHaveLength(1);
  });

  it('defaults to sorting by price per GB of RAM', () => {
    const cheapTotal = offer({ planId: 'small', ramGb: 2, priceMonthly: 10 });
    const betterValue = offer({ planId: 'big', ramGb: 32, priceMonthly: 100 });
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
      offer({ planId: 'a', ramGb: 2, priceMonthly: 20 }),
      offer({ planId: 'b', ramGb: 8, priceMonthly: 20 }),
      offer({ planId: 'c', ramGb: 4, priceMonthly: 20 }),
    ];
    expect(applyFilters(all, { limit: 1 })[0]!.planId).toBe('b');
  });
});

describe('column sorting', () => {
  it('uses a natural direction per column when none is given', () => {
    const small = offer({ planId: 'small', ramGb: 2, priceMonthly: 5 });
    const big = offer({ planId: 'big', ramGb: 64, priceMonthly: 500 });
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

describe('hourly pricing', () => {
  it('sorts by hourly rate independently of the monthly price', async () => {
    const cheapMonthly = offer({ planId: 'monthly-deal', priceMonthly: 10, priceHourly: 0.05 } as any);
    const cheapHourly = offer({ planId: 'hourly-deal', priceMonthly: 40, priceHourly: 0.001 } as any);
    expect(applyFilters([cheapMonthly, cheapHourly], { sort: 'price' })[0]!.planId).toBe('monthly-deal');
    expect(applyFilters([cheapMonthly, cheapHourly], { sort: 'priceHourly' })[0]!.planId).toBe('hourly-deal');
  });

  it('sinks plans with no hourly rate to the bottom in both directions', async () => {
    const known = offer({ planId: 'known', priceHourly: 0.02 } as any);
    const missing = offer({ planId: 'missing' });
    expect(applyFilters([missing, known], { sort: 'priceHourly', sortDir: 'asc' })[0]!.planId).toBe('known');
    expect(applyFilters([missing, known], { sort: 'priceHourly', sortDir: 'desc' })[0]!.planId).toBe('known');
  });
});

describe('GPU is kept separate from system RAM', () => {
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

  it('derives price per GB of VRAM, and leaves it undefined without a GPU', () => {
    expect(gpuBox.pricePerGbVram).toBeCloseTo(2000 / 192, 4);
    expect(plainBox.pricePerGbVram).toBeUndefined();
  });

  it('detects a GPU from VRAM or model alone, not just a count', () => {
    const vultrStyle = offer({ planId: 'vultr-gpu', gpuVramGb: 192, gpuModel: 'NVIDIA' } as any);
    expect(applyFilters([vultrStyle, plainBox], { hasGpu: true }).map((o) => o.planId)).toEqual(['vultr-gpu']);
    expect(applyFilters([vultrStyle, plainBox], { hasGpu: false }).map((o) => o.planId)).toEqual(['plain']);
  });

  it('sorts by price per GB of VRAM, sinking non-GPU plans', () => {
    const value = offer({ planId: 'value', priceMonthly: 100, gpuVramGb: 100 } as any);
    const pricey = offer({ planId: 'pricey', priceMonthly: 400, gpuVramGb: 100 } as any);
    const out = applyFilters([pricey, plainBox, value], { sort: 'pricePerGbVram' });
    expect(out.map((o) => o.planId)).toEqual(['value', 'pricey', 'plain']);
  });

  it('sorts by VRAM, falling back to card count where VRAM is unpublished', () => {
    const noVram = offer({ planId: 'linode-gpu', gpuCount: 4 } as any);
    const out = applyFilters([noVram, gpuBox, plainBox], { sort: 'gpu' });
    expect(out.map((o) => o.planId)).toEqual(['gpu', 'linode-gpu', 'plain']);
  });
});

describe('one bad provider must not empty the whole catalogue', () => {
  const stubDb = { getUserById: async () => undefined } as any;

  const good = (provider: string): VpsCatalogAdapter => ({
    provider, requiresCredentials: false, provisionable: false,
    fetch: async () => ({ offers: [offer({ provider, planId: `${provider}-1` })], skippedNoPrice: 0 }),
  });

  const svc = (adapters: VpsCatalogAdapter[]) =>
    new VpsCatalogService(stubDb, 'test-key', adapters);

  it('still returns healthy providers when one adapter throws', async () => {
    const boom: VpsCatalogAdapter = {
      provider: 'boom', requiresCredentials: false, provisionable: false,
      fetch: async () => { throw new Error('upstream 503'); },
    };
    const r = await svc([good('linode'), boom, good('vultr')]).search('u1', {});
    expect(r.offers.map((o) => o.provider).sort()).toEqual(['linode', 'vultr']);
    expect(r.sources.find((s) => s.provider === 'boom')).toMatchObject({
      status: 'error', offerCount: 0, message: 'upstream 503',
    });
  });

  it('survives an adapter whose result shape is wrong, and does not poison the cache', async () => {
    const malformed: VpsCatalogAdapter = {
      provider: 'malformed', requiresCredentials: false, provisionable: false,
      fetch: async () => [offer({ provider: 'malformed' })] as any,
    };
    const s = svc([good('linode'), malformed]);

    const first = await s.search('u1', {});
    expect(first.offers.map((o) => o.provider)).toEqual(['linode']);
    expect(first.sources.find((x) => x.provider === 'malformed')?.status).toBe('error');

    const second = await s.search('u1', {});
    expect(second.offers.map((o) => o.provider)).toEqual(['linode']);
    expect(second.sources.find((x) => x.provider === 'malformed')?.status).toBe('error');
  });

  it('does not reject when token resolution blows up for a credentialed provider', async () => {
    const failingDb = { getUserById: async () => { throw new Error('mongo unavailable'); } } as any;
    const gated: VpsCatalogAdapter = {
      provider: 'hetzner', requiresCredentials: true, provisionable: true,
      fetch: async () => ({ offers: [], skippedNoPrice: 0 }),
    };
    const r = await new VpsCatalogService(failingDb, 'test-key', [good('vultr'), gated]).search('u1', {});
    expect(r.offers.map((o) => o.provider)).toEqual(['vultr']);
    expect(r.sources.find((s) => s.provider === 'hetzner')?.status).toBe('error');
  });
});

describe('per-location pricing', () => {
  const eu = offer({
    planId: 'cpx11', idSuffix: 'fsn1', priceMonthly: 5.99, bandwidthTb: 20,
    locations: ['fsn1', 'hel1', 'nbg1'],
  } as any);
  const us = offer({
    planId: 'cpx11', idSuffix: 'ash', priceMonthly: 20.49, bandwidthTb: 1,
    locations: ['ash', 'hil'],
  } as any);

  it('gives each price tier a distinct id while keeping planId deployable', () => {
    expect(eu.id).toBe('test:cpx11@fsn1');
    expect(us.id).toBe('test:cpx11@ash');
    expect(eu.planId).toBe('cpx11');
    expect(us.planId).toBe('cpx11');
  });

  it('never returns a price from a location the filter excluded', () => {
    const out = applyFilters([eu, us], { location: 'ash' });
    expect(out).toHaveLength(1);
    expect(out[0]!.priceMonthly).toBe(20.49);
    expect(out[0]!.bandwidthTb).toBe(1);
  });

  it('still finds the cheap EU tier of the same plan', () => {
    const out = applyFilters([eu, us], { location: 'fsn1' });
    expect(out).toHaveLength(1);
    expect(out[0]!.priceMonthly).toBe(5.99);
    expect(out[0]!.bandwidthTb).toBe(20);
  });

  it('prices per GB against the tier actually selected', () => {
    expect(applyFilters([eu, us], { location: 'ash' })[0]!.pricePerGbRam)
      .toBeCloseTo(20.49 / 4, 4);
  });
});

describe('withDerived', () => {
  it('leaves the id unsuffixed when no idSuffix is given', () => {
    expect(offer({ provider: 'hetzner', planId: 'cx53' }).id).toBe('hetzner:cx53');
  });

  it('computes price per GB and a namespaced id', () => {
    const o = offer({ provider: 'hetzner', planId: 'cx53', ramGb: 32, priceMonthly: 22.49 });
    expect(o.id).toBe('hetzner:cx53');
    expect(o.pricePerGbRam).toBeCloseTo(0.703, 3);
  });

  it('does not divide by zero on a 0-RAM plan', () => {
    expect(offer({ ramGb: 0 }).pricePerGbRam).toBe(0);
  });
});

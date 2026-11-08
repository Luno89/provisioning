import { describe, expect, it } from 'vitest';
import { vpsFiltersFrom } from './filters.js';

describe('the catalogue\'s filters as asked in the query', () => {
  it('reads numbers, choices and switches, leaving out what was not asked', () => {
    expect(vpsFiltersFrom({ minRamGb: '8', maxPriceMonthly: '', arch: 'arm', sort: 'price', sortDir: 'desc', hasGpu: 'false', hourlyOnly: 'true', limit: '60' }))
      .toEqual({ filters: { minRamGb: 8, arch: 'arm', sort: 'price', sortDir: 'desc', hasGpu: false, hourlyOnly: true, limit: 60 } });
  });

  it('refuses a choice the catalogue does not have, naming the ones it does', () => {
    expect(vpsFiltersFrom({ sort: 'cheapest' })).toEqual({ problem: 'sort must be one of price, priceHourly, pricePerGbRam, ram, vcpu, disk, bandwidth, name, gpu, pricePerGbVram' });
    expect(vpsFiltersFrom({ arch: 'risc-v' })).toEqual({ problem: 'arch must be one of x86, arm, unknown' });
  });

  it('refuses a number, a switch or a direction it cannot read, rather than leaving the filter out', () => {
    expect(vpsFiltersFrom({ minRamGb: 'eight' })).toEqual({ problem: 'minRamGb must be a number, not "eight"' });
    expect(vpsFiltersFrom({ hasGpu: 'yes', sortDir: 'up' })).toEqual({ problem: 'sortDir must be one of asc, desc; hasGpu must be true or false, not "yes"' });
    expect(vpsFiltersFrom({ hourlyOnly: '1' })).toEqual({ problem: 'hourlyOnly must be true or false, not "1"' });
  });
});

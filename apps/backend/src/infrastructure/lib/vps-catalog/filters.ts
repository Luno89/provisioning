import { textAt } from '../../../platform/lib/json-shapes.js';
import { NATURAL_SORT_DIR, type VpsArch, type VpsCatalogFilters, type VpsCpuType, type VpsSortKey } from './types.js';

const ARCHES: readonly VpsArch[] = ['x86', 'arm', 'unknown'];
const CPU_TYPES: readonly VpsCpuType[] = ['shared', 'dedicated', 'unknown'];

type NumberFilter = 'minRamGb' | 'maxRamGb' | 'minVcpu' | 'minDiskGb' | 'maxPriceMonthly' | 'minGpuVramGb' | 'limit';

const isArch = (value: string): value is VpsArch => (ARCHES as readonly string[]).includes(value);
const isCpuType = (value: string): value is VpsCpuType => (CPU_TYPES as readonly string[]).includes(value);
const isSortKey = (value: string): value is VpsSortKey => Object.hasOwn(NATURAL_SORT_DIR, value);

export function vpsFiltersFrom(query: unknown): { filters: VpsCatalogFilters } | { problem: string } {
  const text = (key: string): string | undefined => textAt(query, key);
  const num = (key: string): number | undefined => {
    const v = text(key);
    return v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : undefined;
  };
  const numbered = (key: NumberFilter): Partial<Record<NumberFilter, number>> => {
    const n = num(key);
    return n === undefined ? {} : { [key]: n };
  };
  const archAsked = text('arch');
  const arch = archAsked && isArch(archAsked) ? archAsked : undefined;
  if (archAsked && !arch) return { problem: `arch must be one of ${ARCHES.join(', ')}` };
  const cpuTypeAsked = text('cpuType');
  const cpuType = cpuTypeAsked && isCpuType(cpuTypeAsked) ? cpuTypeAsked : undefined;
  if (cpuTypeAsked && !cpuType) return { problem: `cpuType must be one of ${CPU_TYPES.join(', ')}` };
  const sortAsked = text('sort');
  const sort = sortAsked && isSortKey(sortAsked) ? sortAsked : undefined;
  if (sortAsked && !sort) return { problem: `sort must be one of ${Object.keys(NATURAL_SORT_DIR).join(', ')}` };
  const sortDir = text('sortDir');
  const location = text('location');
  const provider = text('provider');
  const hasGpu = text('hasGpu');
  return {
    filters: {
      ...numbered('minRamGb'),
      ...numbered('maxRamGb'),
      ...numbered('minVcpu'),
      ...numbered('minDiskGb'),
      ...numbered('maxPriceMonthly'),
      ...(location ? { location } : {}),
      ...(arch ? { arch } : {}),
      ...(cpuType ? { cpuType } : {}),
      ...(hasGpu === 'true' ? { hasGpu: true } : hasGpu === 'false' ? { hasGpu: false } : {}),
      ...numbered('minGpuVramGb'),
      ...(provider ? { provider } : {}),
      ...(text('provisionableOnly') === 'true' ? { provisionableOnly: true } : {}),
      ...(text('hourlyOnly') === 'true' ? { hourlyOnly: true } : {}),
      ...(sort ? { sort } : {}),
      ...(sortDir === 'asc' || sortDir === 'desc' ? { sortDir } : {}),
      ...numbered('limit'),
    },
  };
}

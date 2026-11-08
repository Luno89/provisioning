import { textAt } from '../../../platform/lib/json-shapes.js';
import { NATURAL_SORT_DIR, type VpsArch, type VpsCatalogFilters, type VpsCpuType, type VpsSortKey } from './types.js';

const ARCHES: readonly VpsArch[] = ['x86', 'arm', 'unknown'];
const CPU_TYPES: readonly VpsCpuType[] = ['shared', 'dedicated', 'unknown'];

type NumberFilter = 'minRamGb' | 'maxRamGb' | 'minVcpu' | 'minDiskGb' | 'maxPriceMonthly' | 'minGpuVramGb' | 'limit';

const isArch = (value: string): value is VpsArch => (ARCHES as readonly string[]).includes(value);
const isCpuType = (value: string): value is VpsCpuType => (CPU_TYPES as readonly string[]).includes(value);
const isSortKey = (value: string): value is VpsSortKey => Object.hasOwn(NATURAL_SORT_DIR, value);

const SORT_DIRS = ['asc', 'desc'] as const;

export function vpsFiltersFrom(query: unknown): { filters: VpsCatalogFilters } | { problem: string } {
  const text = (key: string): string | undefined => {
    const value = textAt(query, key);
    return value === '' ? undefined : value;
  };
  const problems: string[] = [];
  const numbered = (key: NumberFilter): Partial<Record<NumberFilter, number>> => {
    const asked = text(key);
    if (asked === undefined) return {};
    const value = Number(asked);
    if (!Number.isFinite(value)) {
      problems.push(`${key} must be a number, not "${asked}"`);
      return {};
    }
    return { [key]: value };
  };
  const flag = (key: string): boolean | undefined => {
    const asked = text(key);
    if (asked === undefined) return undefined;
    if (asked === 'true' || asked === 'false') return asked === 'true';
    problems.push(`${key} must be true or false, not "${asked}"`);
    return undefined;
  };
  const archAsked = text('arch');
  const arch = archAsked && isArch(archAsked) ? archAsked : undefined;
  if (archAsked && !arch) problems.push(`arch must be one of ${ARCHES.join(', ')}`);
  const cpuTypeAsked = text('cpuType');
  const cpuType = cpuTypeAsked && isCpuType(cpuTypeAsked) ? cpuTypeAsked : undefined;
  if (cpuTypeAsked && !cpuType) problems.push(`cpuType must be one of ${CPU_TYPES.join(', ')}`);
  const sortAsked = text('sort');
  const sort = sortAsked && isSortKey(sortAsked) ? sortAsked : undefined;
  if (sortAsked && !sort) problems.push(`sort must be one of ${Object.keys(NATURAL_SORT_DIR).join(', ')}`);
  const sortDirAsked = text('sortDir');
  const sortDir = SORT_DIRS.find((dir) => dir === sortDirAsked);
  if (sortDirAsked && !sortDir) problems.push(`sortDir must be one of ${SORT_DIRS.join(', ')}`);
  const location = text('location');
  const provider = text('provider');
  const hasGpu = flag('hasGpu');
  const hourlyOnly = flag('hourlyOnly');
  const filters: VpsCatalogFilters = {
    ...numbered('minRamGb'),
    ...numbered('maxRamGb'),
    ...numbered('minVcpu'),
    ...numbered('minDiskGb'),
    ...numbered('maxPriceMonthly'),
    ...(location ? { location } : {}),
    ...(arch ? { arch } : {}),
    ...(cpuType ? { cpuType } : {}),
    ...(hasGpu === undefined ? {} : { hasGpu }),
    ...numbered('minGpuVramGb'),
    ...(provider ? { provider } : {}),
    ...(hourlyOnly ? { hourlyOnly } : {}),
    ...(sort ? { sort } : {}),
    ...(sortDir ? { sortDir } : {}),
    ...numbered('limit'),
  };
  return problems.length > 0 ? { problem: problems.join('; ') } : { filters };
}

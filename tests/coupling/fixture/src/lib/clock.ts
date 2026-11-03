import type { VendorClock } from './vendor.js';

export interface Clock {
  now(): number;
}

export const clockFrom = (vendor: VendorClock): Clock => vendor;

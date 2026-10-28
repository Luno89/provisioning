import { addressProblem } from './public-address.js';

export interface InFlightSettings {
  initial: number;
  floor: number;
  ceiling: number;
  tolerance: number;
  shortWindow: number;
  longWindow: number;
  smoothing: number;
}

export const IN_FLIGHT: InFlightSettings = { initial: 50, floor: 10, ceiling: 200, tolerance: 2, shortWindow: 10, longWindow: 500, smoothing: 0.2 };

const HELD_BY_DESIGN = /^\/api\/hub-instance\/projects\/[^/]+\/relay\/?$/;

export const limitedAddress = (address: string): boolean => Boolean(address) && addressProblem(address) === undefined;

export const limitedPath = (path: string): boolean => !HELD_BY_DESIGN.test(path);

const average = (previous: number | undefined, next: number, window: number): number =>
  previous === undefined ? next : previous + (next - previous) * (2 / (window + 1));

export class InFlightLimits {
  private limit: number;
  private short: number | undefined;
  private long: number | undefined;
  private readonly held = new Map<string, number>();

  constructor(private readonly settings: InFlightSettings = IN_FLIGHT) {
    this.limit = settings.initial;
  }

  get cap(): number {
    return Math.floor(this.limit);
  }

  inFlight(address: string): number {
    return this.held.get(address) ?? 0;
  }

  enter(address: string): boolean {
    const now = this.inFlight(address);
    if (now >= this.cap) return false;
    this.held.set(address, now + 1);
    return true;
  }

  leave(address: string): void {
    const now = this.inFlight(address);
    if (now <= 1) this.held.delete(address);
    else this.held.set(address, now - 1);
  }

  answered(seconds: number): void {
    const { floor, ceiling, tolerance, shortWindow, longWindow, smoothing } = this.settings;
    const sample = Math.max(seconds, 1e-6);
    this.short = average(this.short, sample, shortWindow);
    this.long = average(this.long, sample, longWindow);
    const gradient = Math.min(1, Math.max(0.5, (tolerance * this.long) / this.short));
    const wanted = this.limit * gradient + Math.sqrt(this.limit);
    this.limit = Math.min(ceiling, Math.max(floor, this.limit * (1 - smoothing) + wanted * smoothing));
  }
}

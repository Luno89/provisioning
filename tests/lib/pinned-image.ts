import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PINS = resolve(import.meta.dirname, '..', '..', 'dependencies.pins.json');

interface Pin { kind?: string; name: string; version: string; sha256?: string }

export function pinnedImage(name: string, pins: string = readFileSync(PINS, 'utf8')): string {
  const pin = (JSON.parse(pins) as { components: Pin[] }).components.find((one) => one.kind === 'image' && one.name === name);
  if (!pin?.sha256) throw new Error(`dependencies.pins.json pins no image named ${name}`);
  return `${pin.name}:${pin.version}@sha256:${pin.sha256}`;
}

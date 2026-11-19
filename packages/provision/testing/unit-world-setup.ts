import { startWorld } from './world-setup.js';

export default function setup(): Promise<() => Promise<void>> {
  return startWorld({});
}

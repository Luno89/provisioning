import { around } from './registry.js';

async function measured(): Promise<string> {
  return 'measured';
}

export const first = (): Promise<string> => around(measured);

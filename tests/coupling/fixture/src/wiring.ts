import { clockFrom } from './lib/clock.js';
import type { VendorClock } from './lib/vendor.js';
import { make } from './lib/made.js';
import { quiet } from './lib/quiet.js';
import { shout } from './lib/shout.js';
import { finish } from './reader/hooks.js';
import { formatAll, readOne } from './reader/reader.js';
import { MemoryStore } from './store/store.js';
import { PlainStore } from './store/plain.js';

export const wired = (id: string): string => readOne({ store: new PlainStore(), run: shout }, id);

export const kept = new MemoryStore();

export const formatted = formatAll(quiet, ['A']);

export const loud = (id: string): string => shout(id).trim();

export const started = async (id: string): Promise<string> => (await make()).start(id);

export const stamped = (vendor: VendorClock): number => clockFrom(vendor).now();

export const finished = finish({ onDone: shout, onLoud: (id) => quiet(id) }, 'a');

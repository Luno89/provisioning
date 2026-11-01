import { quiet } from './lib/quiet.js';
import { shout } from './lib/shout.js';
import { formatAll, readOne } from './reader/reader.js';
import { MemoryStore } from './store/store.js';
import { PlainStore } from './store/plain.js';

export const wired = (id: string): string => readOne({ store: new PlainStore(), run: shout }, id);

export const kept = new MemoryStore();

export const formatted = formatAll(quiet, ['A']);

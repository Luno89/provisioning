import { readOne } from './reader.js';

export const faked = (): string => readOne({ store: { read: (id) => id }, run: (command) => command }, 'x');

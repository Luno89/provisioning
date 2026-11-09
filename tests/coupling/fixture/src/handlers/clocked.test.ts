import { stampWith } from './clocked.js';

export const stamped = stampWith({ now: () => '2026-11-09T00:00:00.000Z' });

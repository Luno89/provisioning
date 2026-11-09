import { settingsFrom } from './stored.js';

const realToken = async (): Promise<string> => 'signed';

export const made = settingsFrom(realToken);

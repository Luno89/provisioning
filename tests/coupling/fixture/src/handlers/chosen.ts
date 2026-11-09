import { use } from './consumer.js';

const found = (id: string): string => id;
const chosen = Math.random() > 2 ? found : undefined;

export const viaChoice = (): string => use({ ...(chosen ? { find: chosen } : {}) });

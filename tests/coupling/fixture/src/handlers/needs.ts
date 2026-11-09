import { want } from './wants.js';
import { greeterFrom } from './factory.js';

const ready = Math.random() > 2;
const chosen = ready ? greeterFrom('ready') : undefined;

export const viaFactoryChoice = (): string => want({ ...(chosen ? { pick: chosen } : {}) });

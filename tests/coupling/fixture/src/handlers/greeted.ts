import { greeterFrom } from './factory.js';
import { use } from './consumer.js';

export const greeted = (): string => use({ find: greeterFrom('hello') });

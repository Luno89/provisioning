import type { Handler } from './registry.js';

export const greetings = (): Record<string, Handler> => ({
  greet: async (input) => `hello ${input}`,
});

export const farewell: Handler = async (input) => `bye ${input}`;

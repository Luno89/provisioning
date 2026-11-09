import { run, type Handler } from '@fixture/runner';

export const handlers: Record<string, Handler> = {
  greet: (input) => `hello ${input}`,
};

export const greeted = run(handlers, 'greet');

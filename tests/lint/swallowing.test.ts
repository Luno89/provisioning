import { type ESLint, Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { ASYNC_HANDLER_IN_VARIABLE, FAILURES_PLUGIN, SWALLOWING } from '../../eslint.bug-backed.mjs';

const lint = (code: string, extra: unknown[] = []): string[] => {
  const linter = new Linter({ configType: 'flat' });
  const messages = linter.verify(code, [{
    files: ['**/*.ts'],
    languageOptions: { parser: tseslint.parser },
    plugins: { failures: FAILURES_PLUGIN as ESLint.Plugin },
    rules: { 'no-restricted-syntax': ['error', ...SWALLOWING, ...extra], 'failures/no-warn-and-carry-on': 'error' },
  }], { filename: 'sample.ts' });
  return messages.map((message) => message.message);
};

describe('a catch that answers with a made-up value', () => {
  it.each([
    ['nothing', 'try { run(); } catch (e) { log(e); return; }'],
    ['undefined', 'try { run(); } catch (e) { return undefined; }'],
    ['null', 'try { run(); } catch (e) { return null; }'],
    ['a string', "try { run(); } catch (e) { console.log(e); return 'running'; }"],
    ['a number', 'try { run(); } catch (e) { return 0; }'],
    ['false', 'try { run(); } catch (e) { return false; }'],
    ['an empty array', 'try { run(); } catch (e) { return []; }'],
    ['an empty object', 'try { run(); } catch (e) { return {}; }'],
  ])('refuses a return of %s', (_name, code) => {
    expect(lint(code)).toHaveLength(1);
  });

  it('allows a conditional return, a rethrow and a return of something computed', () => {
    expect(lint('try { run(); } catch (e) { if (gone(e)) return null; throw e; }')).toEqual([]);
    expect(lint('try { run(); } catch (e) { console.error(e); throw e; }')).toEqual([]);
    expect(lint('try { run(); } catch (e) { return failed(e); }')).toEqual([]);
  });
});

describe('a callback handed to catch or to the second place of then', () => {
  it('refuses a block body that returns a made-up value after a log line', () => {
    expect(lint("p.catch((err: Error): RunLife => { log(err.message); return 'running'; });")).toHaveLength(1);
    expect(lint('p.catch(function (err) { return null; });')).toHaveLength(1);
    expect(lint('p.then(ok, (err) => { log(err); return []; });')).toHaveLength(1);
  });

  it('refuses a block body of only console calls', () => {
    expect(lint('p.catch((err: Error) => { console.error(err.message); });')).toHaveLength(1);
    expect(lint('p.then(ok, function (err) { console.warn(err); });')).toHaveLength(1);
  });

  it('allows a conditional return, a rethrow, a computed return and a first-place then callback', () => {
    expect(lint('p.catch((err) => { if (gone(err)) return null; throw err; });')).toEqual([]);
    expect(lint('p.catch((err) => { console.error(err); throw err; });')).toEqual([]);
    expect(lint("p.catch((err) => { log(err); return { state: 'failed' }; });")).toEqual([]);
    expect(lint('p.then((value) => { console.log(value); });')).toEqual([]);
    expect(lint('p.then((value) => { return null; }, handle);')).toEqual([]);
  });
});

describe('a catch handler with a parameter that answers with an empty value', () => {
  it.each([
    ['undefined', 'p.catch((err) => undefined);'],
    ['null', 'p.catch((err) => null);'],
    ['a literal', "p.catch((err) => 'none');"],
    ['an empty array', 'p.catch((err) => []);'],
    ['an empty object', 'p.catch((err) => ({}));'],
    ['an empty body', 'p.catch((err) => {});'],
  ])('refuses %s', (_name, code) => {
    expect(lint(code)).toHaveLength(1);
  });

  it('allows ignore(why), a failure shown as a result, and a handler that does something with the error', () => {
    expect(lint("p.catch(ignore('why'));")).toEqual([]);
    expect(lint("p.catch((err) => ({ state: 'failed', error: err.message }));")).toEqual([]);
    expect(lint('p.catch((err) => report(err));')).toEqual([]);
  });
});

describe('a catch that warns and carries on', () => {
  it('refuses a catch whose every statement is a console call', () => {
    expect(lint("try { run(); } catch (e) { console.warn('x', e); }")).toHaveLength(1);
    expect(lint('try { run(); } catch (e) { console.warn(e); console.error(e); }')).toHaveLength(1);
  });

  it('allows a catch that logs and rethrows or returns, and one that does other work', () => {
    expect(lint('try { run(); } catch (e) { console.error(e); throw e; }')).toEqual([]);
    expect(lint('try { run(); } catch (e) { console.error(e); return failed(e); }')).toEqual([]);
    expect(lint('try { run(); } catch (e) { console.error(e); record(e); }')).toEqual([]);
  });
});

describe('an async Express handler held in a variable', () => {
  const run = (code: string): string[] => lint(code, [ASYNC_HANDLER_IN_VARIABLE]);

  it('refuses an async function typed RequestHandler, bare or from express', () => {
    expect(run('const requireAuth: RequestHandler = async (req, res, next) => { next(); };')).toHaveLength(1);
    expect(run('const requireAuth: express.RequestHandler = async function (req, res, next) { next(); };')).toHaveLength(1);
  });

  it('allows a wrapped async function and a synchronous handler', () => {
    expect(run('const requireAuth: RequestHandler = asyncRoute(async (req, res, next) => { next(); });')).toEqual([]);
    expect(run('const requireAuth: RequestHandler = (req, res, next) => { next(); };')).toEqual([]);
  });
});

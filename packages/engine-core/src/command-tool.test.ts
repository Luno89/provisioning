import { describe, it, expect } from 'vitest';
import { placeholdersIn, quoteArgument, renderCommand } from './command-tool.js';

describe('the blanks a command template leaves', () => {
  it('names each one once', () => {
    expect(placeholdersIn('rg --count {pattern} {path} {pattern}')).toEqual(['pattern', 'path']);
  });

  it('finds none in a command that takes nothing', () => {
    expect(placeholdersIn('go version')).toEqual([]);
  });
});

describe('putting an argument into a command', () => {
  it('quotes it, so a space is one argument and not two', () => {
    expect(renderCommand('ls {path}', { path: 'my files' })).toEqual({ command: "ls 'my files'" });
  });

  it('gives a quote of its own no way out of the quoting', () => {
    expect(renderCommand('echo {say}', { say: "it's" })).toEqual({ command: "echo 'it'\\''s'" });
  });

  it('leaves a semicolon, backtick or $(…) as text rather than something to run', () => {
    const rendered = renderCommand('echo {say}', { say: '; rm -rf /; `id`; $(id)' });

    expect(rendered).toEqual({ command: "echo '; rm -rf /; `id`; $(id)'" });
  });

  it('keeps a newline inside the argument instead of starting a second command', () => {
    expect(renderCommand('echo {say}', { say: 'one\nrm -rf /' })).toEqual({ command: "echo 'one\nrm -rf /'" });
  });

  it('spreads a list into separate quoted arguments', () => {
    expect(renderCommand('rg {flags} {pattern}', { flags: ['-i', '--count'], pattern: 'x' }))
      .toEqual({ command: "rg '-i' '--count' 'x'" });
  });

  it('renders a number and a flag without quoting trouble', () => {
    expect(renderCommand('head -n {lines} {path}', { lines: 20, path: 'a.txt' }))
      .toEqual({ command: "head -n '20' 'a.txt'" });
  });

  it('leaves an argument that was never given empty rather than guessing', () => {
    expect(renderCommand('ls {path}', {})).toEqual({ command: 'ls ' });
  });

  it('refuses an argument it cannot put on a command line at all', () => {
    expect(renderCommand('ls {path}', { path: { nested: true } }))
      .toEqual({ refused: 'path has to be text, a number, or a list of them' });
  });
});

describe('quoting one value', () => {
  it('wraps it so the shell reads it as one word', () => {
    expect(quoteArgument('a b')).toBe("'a b'");
  });
});

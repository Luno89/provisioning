import { describe, expect, it } from 'vitest';
import { argvOf, CommandFailed, shown } from './commands.js';

describe('argvOf', () => {
  it('runs the program itself with its arguments, never through a shell', () => {
    expect(argvOf({ command: 'docker', args: ['run', '--rm', 'hello world'] })).toEqual(['docker', 'run', '--rm', 'hello world']);
    expect(argvOf({ command: 'true' })).toEqual(['true']);
  });

  it('runs under sudo with the command\'s own environment carried through env, since sudo drops it', () => {
    expect(argvOf({ command: 'k3s', args: ['server'], sudo: true })).toEqual(['sudo', '--', 'k3s', 'server']);
    expect(argvOf({ command: 'k3s', args: ['server'], sudo: true, env: { INSTALL_K3S_SKIP_START: 'true' } })).toEqual(['sudo', '--', 'env', 'INSTALL_K3S_SKIP_START=true', 'k3s', 'server']);
  });

  it('leaves the environment out of the arguments without sudo, where the process gets it directly', () => {
    expect(argvOf({ command: 'k3s', env: { A: '1' } })).toEqual(['k3s']);
  });
});

describe('a command that failed', () => {
  it('names the command as it could be typed again, and how it ended', () => {
    expect(shown(['sh', '-c', 'echo before; exit 3'])).toBe(`sh -c 'echo before; exit 3'`);
    expect(shown(['echo', `it's`])).toBe(`echo 'it'\\''s'`);
    expect(new CommandFailed(['sh', '-c', 'exit 3'], { code: 3 }, []).message).toBe(`sh -c 'exit 3' exited with 3`);
    expect(new CommandFailed(['sleep', '100'], { signal: 'SIGKILL' }, []).message).toBe('sleep 100 was stopped by SIGKILL');
    expect(new CommandFailed(['nope'], { notStarted: 'spawn nope ENOENT' }, []).message).toBe('nope could not start: spawn nope ENOENT');
  });
});

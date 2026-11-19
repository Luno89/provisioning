import { describe, expect, it } from 'vitest';
import type { Command } from '../src/commands.js';
import { containersOn, throwawayLabel, THIS_CHECKOUT } from './containers.js';
import { fakeCommands, type Answer } from './fake-commands.js';

const argv = (command: Command): string => [command.command, ...(command.args ?? [])].join(' ');

const dockerAnswering = (answers: Record<string, Answer>) => fakeCommands((command) => answers[argv(command)]);

const NEVER_A_PROCESS = 4_194_305;

describe('the containers a test world runs', () => {
  it('say what state each is in and how it exited, and that one is gone when Docker knows no such container', async () => {
    const commands = dockerAnswering({
      'docker inspect -f {{.State.Status}} {{.State.ExitCode}} web': { stdout: 'exited 3\n' },
      'docker inspect -f {{.State.Status}} {{.State.ExitCode}} gone': { code: 1, stderr: 'Error: No such object: gone\n' },
    });
    const containers = containersOn(commands);
    expect(await containers.status('web')).toEqual({ state: 'exited', code: '3' });
    expect(await containers.status('gone')).toBeUndefined();
  });

  it('are taken away at once with their volumes, and asking to take away one that is gone does nothing', async () => {
    const commands = dockerAnswering({
      'docker inspect -f {{.State.Status}} {{.State.ExitCode}} web': { stdout: 'running 0\n' },
      'docker stop --signal KILL --timeout -1 web': { stdout: 'web\n' },
      'docker rm --volumes web': { stdout: 'web\n' },
      'docker inspect -f {{.State.Status}} {{.State.ExitCode}} gone': { code: 1 },
    });
    const containers = containersOn(commands);
    await containers.remove('web');
    await containers.remove('gone');
    expect(commands.ran.map(argv)).toEqual([
      'docker inspect -f {{.State.Status}} {{.State.ExitCode}} web',
      'docker stop --signal KILL --timeout -1 web',
      'docker rm --volumes web',
      'docker inspect -f {{.State.Status}} {{.State.ExitCode}} gone',
    ]);
  });

  it('give their last lines, what they wrote to stderr included', async () => {
    const commands = dockerAnswering({ 'docker logs --tail 2 web': { stdout: 'listening\n', stderr: 'the data folder is not writable\n' } });
    expect(await containersOn(commands).logs('web', 2)).toBe('listening\nthe data folder is not writable');
  });

  it('run a command inside one, as a user, with what it reads given to it', async () => {
    const commands = fakeCommands((command) => (argv(command) === 'docker exec -i --user 0 db mongosh --quiet' ? { stdout: `${command.stdin ?? ''} read\n` } : undefined));
    expect(await containersOn(commands).exec('db', ['mongosh', '--quiet'], { user: '0', input: 'db.ping()' })).toBe('db.ping() read');
  });

  it('left by a test run that is gone are found by the checkout they were made from, and those whose maker still runs are kept', async () => {
    const gone = NEVER_A_PROCESS;
    const commands = dockerAnswering({
      [`docker ps -a --filter label=koala.throwaway-checkout=${THIS_CHECKOUT} --format {{.Names}} {{.Label "koala.throwaway-of"}}`]: { stdout: `orphan ${gone}\nkept ${process.pid}\n` },
    });
    expect(await containersOn(commands).throwawayOrphans()).toEqual(['orphan']);
    expect(throwawayLabel(gone)).toEqual(['--label', `koala.throwaway-of=${gone}`, '--label', `koala.throwaway-checkout=${THIS_CHECKOUT}`]);
  });

  it('name the port Docker published for one they serve inside', async () => {
    const commands = dockerAnswering({ 'docker port web 8080': { stdout: '127.0.0.1:49153\n[::1]:49153\n' } });
    expect(await containersOn(commands).published('web', 8080)).toBe(49153);
  });
});

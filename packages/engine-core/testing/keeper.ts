import { spawn } from 'node:child_process';

const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error('the keeper is told the program to keep: node keeper.ts <command> [args…]');

const HANDED_ON = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const;

const program = spawn(command, args, { stdio: ['ignore', 'inherit', 'inherit'] });
const ended = new Promise<void>((done) => { program.once('exit', () => { done(); }); });

for (const signal of HANDED_ON) process.on(signal, () => undefined);

const endEverything = async (): Promise<void> => {
  program.kill('SIGKILL');
  await ended;
  process.kill(-process.pid, 'SIGKILL');
};

process.stdin.on('end', () => { void endEverything(); });
process.stdin.on('error', () => { void endEverything(); });
process.stdin.resume();

program.on('error', (err) => {
  process.stderr.write(`${command} could not start: ${err.message}\n`);
  process.exit(127);
});

program.on('exit', (code, signal) => {
  if (code !== null) process.exit(code);
  for (const name of HANDED_ON) process.removeAllListeners(name);
  process.kill(process.pid, signal ?? 'SIGKILL');
});

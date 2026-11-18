import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { until } from './until.js';

const SCRIPT = resolve(import.meta.dirname, '..', '..', 'scripts', 'stop-dev-servers.sh');
const NODE = process.execPath;

const started: ChildProcess[] = [];
const servers: Server[] = [];
afterEach(() => {
  for (const child of started.splice(0)) child.kill();
  for (const server of servers.splice(0)) server.close();
});

const alive = (child: ChildProcess): boolean => child.exitCode === null && child.signalCode === null;

async function aServer(): Promise<{ child: ChildProcess; port: number }> {
  const child = spawn(NODE, ['-e', "const s=require('node:net').createServer(()=>{}).listen(0,'127.0.0.1',()=>console.log(s.address().port));setInterval(()=>{},1e9)"], { stdio: ['ignore', 'pipe', 'inherit'] });
  started.push(child);
  const port = await new Promise<number>((done) => child.stdout!.once('data', (line: Buffer) => done(Number(String(line).trim()))));
  return { child, port };
}

function stopServersOn(port: number): Promise<number | null> {
  const run = spawn('bash', [SCRIPT, String(port)], { stdio: 'inherit' });
  return new Promise((done) => run.on('exit', (code) => done(code)));
}

describe('stopping dev\'s servers before a run starts its own', () => {
  it('stops what listens on the port and leaves what is only connected to it, such as ship waiting on the stack', async () => {
    const server = await aServer();
    const client = spawn(NODE, ['-e', `const c=require('node:net').connect(${server.port},'127.0.0.1',()=>console.log('connected'));c.on('error',()=>{});process.stdin.on('data',()=>console.log('still here'))`], { stdio: ['pipe', 'pipe', 'inherit'] });
    started.push(client);
    const clientEnded = new Promise<string>((done) => client.once('exit', (code, signal) => done(`stopped (${signal ?? code})`)));
    await new Promise((done) => client.stdout!.once('data', done));

    expect(await stopServersOn(server.port)).toBe(0);

    await until('the server stopped', async () => !alive(server.child));
    const answer = Promise.race([new Promise<string>((done) => client.stdout!.once('data', (line: Buffer) => done(String(line).trim()))), clientEnded]);
    client.stdin!.on('error', () => {}).write('are you there\n');
    expect(await answer).toBe('still here');
  });

  it('passes when nothing listens on the port', async () => {
    const free = createServer();
    servers.push(free);
    const port = await new Promise<number>((done) => free.listen(0, '127.0.0.1', () => done((free.address() as { port: number }).port)));
    await new Promise((done) => free.close(done));
    expect(await stopServersOn(port)).toBe(0);
  });
});

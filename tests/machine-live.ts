import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
dotenv.config({ path: fileURLToPath(new URL('../apps/backend/.env', import.meta.url)) });
import axios from 'axios';
import { createDatabase } from '../apps/backend/src/lib/db-interface.js';
import { signJWT } from '../apps/backend/src/lib/auth.js';
import { loadKeys } from '../apps/backend/src/lib/keys.js';
import { createDisposableVm, type DisposableVm } from './lib/disposable-vm.js';
import { ACP_STUB, chatsOnTheMachine, type Api } from './lib/machine-chat.js';

const BASE = process.env.MACHINE_LIVE_URL ?? 'http://localhost:3001/api';
const OWNER = process.env.MACHINE_LIVE_OWNER ?? process.env.CHECKS_LIVE_OWNER;
const NAME = `machine-live-${Date.now().toString(36)}`;
const NODE = process.version;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const LOOPBACK = `#!/bin/sh
sysctl -qw net.ipv4.conf.all.route_localnet=1
for port in 3001 7233; do
  iptables -t nat -C OUTPUT -o lo -d 127.0.0.1 -p tcp --dport $port -j DNAT --to-destination 10.0.2.2:$port 2>/dev/null || \\
    iptables -t nat -A OUTPUT -o lo -d 127.0.0.1 -p tcp --dport $port -j DNAT --to-destination 10.0.2.2:$port
done
iptables -t nat -C POSTROUTING -d 10.0.2.2 -j MASQUERADE 2>/dev/null || iptables -t nat -A POSTROUTING -d 10.0.2.2 -j MASQUERADE
`;

const LOOPBACK_UNIT = `[Unit]
Description=This computer's Koala at the VM's localhost
Before=network-online.target
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/koala-loopback
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
`;

interface Agent { id: string; state: string; source: string; version?: string; reason?: string }
interface Machine { id: string; name: string; online: boolean; connectedAt?: string; os?: string; agents: Agent[] }

function ssh(vm: DisposableVm, command: string, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('ssh', [
      '-i', vm.privateKeyPath, '-p', String(vm.port),
      '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'BatchMode=yes', '-o', 'LogLevel=ERROR',
      `${vm.username}@${vm.host}`, `bash -lc ${JSON.stringify(command)}`,
    ], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${command.slice(0, 80)}: ${stderr || err.message}\n${stdout}`));
      else resolve(stdout);
    });
    if (input !== undefined) child.stdin!.end(input);
  });
}

const write = (vm: DisposableVm, file: string, content: string, mode = '644', sudo = false) =>
  ssh(vm, `${sudo ? 'sudo ' : ''}mkdir -p "$(dirname ${file})" && cat | ${sudo ? 'sudo ' : ''}tee ${file} >/dev/null && ${sudo ? 'sudo ' : ''}chmod ${mode} ${file}`, content);

async function main(): Promise<void> {
  assert.ok(OWNER, 'set MACHINE_LIVE_OWNER (or CHECKS_LIVE_OWNER) to the person the machine joins');
  const db = createDatabase();
  await db.init();
  const user = await db.getUserById(OWNER);
  assert.ok(user, 'no such user');
  const http = axios.create({ baseURL: BASE, proxy: false, timeout: 0, validateStatus: () => true, headers: { Cookie: `session=${signJWT({ userId: user.id, email: user.email }, loadKeys(process.env).session, 4 * 3600)}` } });

  const machines = async (): Promise<Machine[]> => (await http.get('/mesh/local-agents')).data;
  const mine = async (): Promise<Machine | undefined> => (await machines()).find((machine) => machine.name === NAME);
  const until = async <T>(what: string, minutes: number, check: () => Promise<T | undefined>): Promise<T> => {
    const ends = Date.now() + minutes * 60_000;
    while (Date.now() < ends) {
      const found = await check();
      if (found !== undefined) return found;
      await sleep(3000);
    }
    throw new Error(`${what} did not happen within ${minutes} minutes`);
  };

  let vm: DisposableVm | undefined;
  try {
    console.log(`[1] a fresh Ubuntu machine with nothing of Koala's on it: ${NAME}`);
    vm = await createDisposableVm(NAME, { memoryMB: 2048, cpus: 2, diskGB: 10, reboots: true });

    console.log(`[2] it has Node ${NODE}, a coding agent that speaks ACP (gemini), and Claude Code and Codex without their adapters; this computer is its localhost`);
    await ssh(vm, `mkdir -p ~/.local/node ~/agents && curl -fsSL https://nodejs.org/dist/${NODE}/node-${NODE}-linux-x64.tar.xz | tar -xJf - -C ~/.local/node --strip-components=1`);
    await ssh(vm, `printf '%s\\n' 'export PATH="$HOME/.local/node/bin:$HOME/agents:$PATH"' >> ~/.profile`);
    await write(vm, '~/agents/gemini', ACP_STUB, '755');
    await write(vm, '~/agents/claude', '#!/bin/sh\necho "claude 2.0.0"\n', '755');
    await write(vm, '~/agents/codex', '#!/bin/sh\necho "codex-cli 0.50.0"\n', '755');
    await write(vm, '/usr/local/sbin/koala-loopback', LOOPBACK, '755', true);
    await write(vm, '/etc/systemd/system/koala-loopback.service', LOOPBACK_UNIT, '644', true);
    await ssh(vm, 'sudo systemctl daemon-reload && sudo systemctl enable --now koala-loopback.service');
    assert.match(await ssh(vm, 'node --version && command -v gemini && curl -fsS -o /dev/null -w "%{http_code}" http://localhost:3001/machine.sh'), /200$/);

    console.log('[3] the command from My Machines installs it, lists the agents it found without installing an adapter (--adapters none), starts it as a service, and keeps it starting with the machine');
    const made = await http.post('/mesh/local-agents/join-code', {});
    assert.equal(made.status, 201, JSON.stringify(made.data));
    const command = (made.data as { command: string }).command;
    assert.match(command, /^curl -fsSL http:\/\/localhost:3001\/machine\.sh \| sh -s -- \S+$/);
    const installed = (await ssh(vm, `${command} --yes --adapters none`)).replace(/\x1b\[[0-9;]*m/g, '');
    console.log(installed.split('\n').filter((line) => line.trim()).map((line) => `    ${line.trim()}`).join('\n'));
    assert.match(installed, /running as the koala-machine service/);
    assert.match(installed, /it starts when this machine starts, without you logging in/);
    assert.equal((await ssh(vm, 'stat -c %a ~/.config/koala/machine.json')).trim(), '600');
    assert.doesNotMatch(installed, /KOALA_DEVICE_TOKEN|"token"/);
    assert.match(installed, /✓ Gemini CLI \(Stub Agent\) 1\.2\.3/);
    assert.match(installed, /Install Claude Code, Codex later with Install adapter on My Machines\./);

    const joined = await until('the machine connecting', 3, async () => {
      const found = await mine();
      return found?.online && found.agents.some((agent) => agent.state !== 'checking') && found.agents.length >= 3 ? found : undefined;
    });
    assert.equal(joined.os, 'Linux x86_64');
    assert.deepEqual(joined.agents.map((agent) => [agent.id, agent.state]).sort(), [['claude', 'needs-adapter'], ['codex', 'needs-adapter'], ['gemini', 'ready']]);
    assert.equal(joined.agents.find((agent) => agent.id === 'gemini')?.version, '1.2.3');
    console.log('    connected: gemini ready (1.2.3, confirmed over ACP), claude and codex need their adapters');

    console.log('[4] after the machine restarts, nobody logs in, and it connects again on its own');
    const before = joined.connectedAt;
    await ssh(vm, 'sudo systemctl reboot').catch(() => undefined);
    await until('the machine going offline', 2, async () => ((await mine())?.online ? undefined : true));
    const back = await until('the machine coming back', 5, async () => {
      const found = await mine();
      return found?.online && found.connectedAt !== before ? found : undefined;
    });
    console.log(`    back at ${back.connectedAt}, with nobody signed in`);

    console.log('[5] Install adapter installs Claude Code\'s ACP adapter, the package the ACP registry names, on the machine, which then finds it');
    const answer = await http.post(`/mesh/local-agents/${back.id}/agents/claude/install`, {});
    assert.equal(answer.status, 200, JSON.stringify(answer.data));
    assert.equal((answer.data as { ok: boolean; output: string }).ok, true, (answer.data as { output: string }).output);
    const claude = await until('claude being looked at again', 3, async () => {
      const agent = (await mine())?.agents.find((candidate) => candidate.id === 'claude');
      return agent && agent.state !== 'needs-adapter' && agent.state !== 'checking' ? agent : undefined;
    });
    assert.equal(claude.state, 'ready', `the adapter installed but ${claude.state}: ${claude.reason ?? ''}`);
    console.log(`    claude ready through its adapter${claude.version ? ` (${claude.version})` : ''}`);

    console.log('[6] running the command again with --yes installs Codex\'s adapter from the script, and replaces the machine rather than adding a second');
    const remade = await http.post('/mesh/local-agents/join-code', {});
    assert.equal(remade.status, 201, JSON.stringify(remade.data));
    const again = (await ssh(vm, `${(remade.data as { command: string }).command} --yes`)).replace(/\x1b\[[0-9;]*m/g, '');
    assert.match(again, /✓ Codex[^\n]*, through @agentclientprotocol\/codex-acp/, again);
    const rejoined = await until('the machine connecting again', 3, async () => {
      const found = (await machines()).filter((machine) => machine.name === NAME);
      return found.length === 1 && found[0]!.online && found[0]!.connectedAt !== back.connectedAt ? found[0] : undefined;
    });
    assert.equal(rejoined.id, back.id);
    const codex = await until('codex showing ready', 3, async () => (await mine())?.agents.find((agent) => agent.id === 'codex' && agent.state === 'ready'));
    console.log(`    codex ready through its adapter${codex.version ? ` (${codex.version})` : ''}; still one machine, ${rejoined.id}`);

    console.log('[7] a chat on its gemini runs on the machine: the large message reaches it through the encrypted, offloaded payloads, and the next turn continues the session');
    const api: Api = async (method, path, body) => {
      const answer = await http.request({ method, url: path, ...(body === undefined ? {} : { data: body }) });
      return { status: answer.status, data: answer.data };
    };
    const said = await chatsOnTheMachine(api, rejoined.id);
    console.log(said.map((line) => `    ${line}`).join('\n'));

    console.log('machine live — PASS');
  } finally {
    console.log('[8] removing the machine, its project and the VM');
    const found = await mine().catch(() => undefined);
    if (found) {
      const removed = await http.delete(`/mesh/local-agents/${found.id}`);
      console.log(`    the machine: ${removed.status}`);
      const project = (await db.getProjects()).find((candidate) => candidate.executionTarget?.kind === 'local-device' && candidate.executionTarget.deviceId === found.id);
      if (project) console.log(`    its project: ${(await http.delete(`/projects/${project.id}`, { data: { confirm: project.name } })).status}`);
    }
    await vm?.destroy();
    console.log('    the VM is gone');
  }
}

main().then(() => process.exit(0), (err) => {
  console.error(err);
  process.exit(1);
});

import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import axios from 'axios';
import { createDatabase } from '../apps/backend/src/platform/lib/db-interface.js';
import { createDisposableVm, type DisposableVm } from './lib/disposable-vm.js';
import { ACP_STUB, chatsOnTheMachine, type Api } from './lib/machine-chat.js';
import { startOwnStack, type OwnStack } from './lib/own-stack.js';

const NAME = `machine-live-${Date.now().toString(36)}`;
const NODE = process.version;
const REPO = fileURLToPath(new URL('..', import.meta.url));
const BEFORE_SELF_UPDATE = '4e711811ab8aee66c622007b538453c1e8bf26d7';
const AGENT_DIR = '~/.local/share/koala/machine';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const loopback = (ports: number[]) => `#!/bin/sh
sysctl -qw net.ipv4.conf.all.route_localnet=1
for port in ${ports.join(' ')}; do
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
interface AgentUpdate { state: string; current: string; running?: string; reason?: string }
interface Machine { id: string; name: string; online: boolean; connectedAt?: string; os?: string; agents: Agent[]; agentUpdate?: AgentUpdate }

function agentBefore(commit: string): Buffer {
  const work = mkdtempSync(path.join(os.tmpdir(), 'machine-live-agent-'));
  try {
    execFileSync('sh', ['-c', `git -C "${REPO}" archive "${commit}" apps/local-agent | tar -x -C "${work}"`]);
    symlinkSync(path.join(REPO, 'node_modules'), path.join(work, 'node_modules'));
    execFileSync(process.execPath, [path.join(work, 'apps/local-agent/scripts/bundle-machine.mjs'), path.join(work, 'out')], { stdio: ['ignore', 'ignore', 'inherit'] });
    return readFileSync(path.join(work, 'out/machine-agent.tgz'));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

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
  console.log('[0] a Koala of this suite\'s own, from this commit\'s image: its backend and engine worker, its database and its Temporal namespace');
  const own = await startOwnStack('machine-live');
  const db = createDatabase({ ...process.env, MONGO_URI: own.root.mongoUri });
  let vm: DisposableVm | undefined;
  let passed = false;
  try {
    await db.init();
    console.log(`    ${own.url}, its machines reaching Temporal through ${own.gatewayPort}, owned by ${own.owner.email}`);
    await stages(own, db, (made) => { vm = made; });
    passed = true;
  } finally {
    console.log('[12] removing the VM and this suite\'s Koala');
    if (!passed) console.log(`    the backend said, last:\n${own.logs('backend', 40).split('\n').map((line) => `      ${line}`).join('\n')}`);
    await vm?.destroy();
    console.log('    the VM is gone');
    await db.close?.();
    await own.stop();
    console.log('    its containers, database and namespace are gone');
  }
}

async function stages(own: OwnStack, db: ReturnType<typeof createDatabase>, madeVm: (vm: DisposableVm) => void): Promise<void> {
  let vm: DisposableVm | undefined;
  const http = axios.create({ baseURL: own.api, proxy: false, timeout: 0, validateStatus: () => true, headers: { Cookie: own.owner.cookie } });
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

  const served = async (): Promise<string> => String((await http.get('/machines/agent.tgz.sha256')).data).trim().split(/\s+/)[0]!;
  const onVm = async (command: string): Promise<string> => (await ssh(vm!, command)).trim();
  const agentOnVm = async () => ({
    bundle: await onVm(`cat ${AGENT_DIR}/bundle.sha256 2>/dev/null || echo none`),
    pid: await onVm('systemctl --user show -p MainPID --value koala-machine'),
    active: await onVm('systemctl --user is-active koala-machine || true'),
  });
  const updateIs = (state: string, seen?: Set<string>) => async (): Promise<Machine | undefined> => {
    const found = await mine();
    if (found?.agentUpdate) seen?.add(found.agentUpdate.state);
    return found?.online && found.agentUpdate?.state === state ? found : undefined;
  };

  {
    console.log(`[1] a fresh Ubuntu machine with nothing of Koala's on it: ${NAME}`);
    vm = await createDisposableVm(NAME, { memoryMB: 2048, cpus: 2, diskGB: 10, reboots: true });
    madeVm(vm);

    console.log(`[2] it has Node ${NODE}, a coding agent that speaks ACP (gemini), and Claude Code and Codex without their adapters; this computer is its localhost`);
    await ssh(vm, `mkdir -p ~/.local/node ~/agents && curl -fsSL https://nodejs.org/dist/${NODE}/node-${NODE}-linux-x64.tar.xz | tar -xJf - -C ~/.local/node --strip-components=1`);
    await ssh(vm, `printf '%s\\n' 'export PATH="$HOME/.local/node/bin:$HOME/agents:$PATH"' >> ~/.profile`);
    await write(vm, '~/agents/gemini', ACP_STUB, '755');
    await write(vm, '~/agents/claude', '#!/bin/sh\necho "claude 2.0.0"\n', '755');
    await write(vm, '~/agents/codex', '#!/bin/sh\necho "codex-cli 0.50.0"\n', '755');
    await write(vm, '/usr/local/sbin/koala-loopback', loopback([own.apiPort, own.gatewayPort]), '755', true);
    await write(vm, '/etc/systemd/system/koala-loopback.service', LOOPBACK_UNIT, '644', true);
    await ssh(vm, 'sudo systemctl daemon-reload && sudo systemctl enable --now koala-loopback.service');
    assert.match(await ssh(vm, `node --version && command -v gemini && curl -fsS -o /dev/null -w "%{http_code}" http://localhost:${own.apiPort}/machine.sh`), /200$/);

    console.log('[3] the command from My Machines installs it, lists the agents it found without installing an adapter (--adapters none), starts it as a service, and keeps it starting with the machine');
    const made = await http.post('/mesh/local-agents/join-code', {});
    assert.equal(made.status, 201, JSON.stringify(made.data));
    const command = (made.data as { command: string }).command;
    assert.equal(command.replace(/\S+$/, ''), `curl -fsSL http://localhost:${own.apiPort}/machine.sh | sh -s -- `);
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
    const first = await served();
    assert.equal((await agentOnVm()).bundle, first, 'the install did not record the bundle it installed');
    const upToDate = await until('My Machines saying its agent is up to date', 1, updateIs('current'));
    assert.deepEqual(upToDate.agentUpdate, { state: 'current', current: first, running: first });
    console.log(`    its agent is ${first.slice(0, 12)}, the bundle Koala serves, and My Machines says it is up to date`);

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

    console.log(`[6] an agent from before agents updated themselves (${BEFORE_SELF_UPDATE.slice(0, 9)}) says nothing about which it is, and My Machines says it is too old to update itself`);
    const old = agentBefore(BEFORE_SELF_UPDATE);
    await ssh(vm, 'cat > /tmp/old-agent.tgz', old.toString('base64'));
    await onVm(`systemctl --user stop koala-machine && rm -rf ${AGENT_DIR} && mkdir -p ${AGENT_DIR} && base64 -d /tmp/old-agent.tgz | tar -xz -C ${AGENT_DIR} && cd ${AGENT_DIR} && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error >/dev/null && systemctl --user start koala-machine`);
    const tooOld = await until('My Machines saying its agent is too old', 3, updateIs('too-old'));
    assert.deepEqual(tooOld.agentUpdate, { state: 'too-old', current: first });
    assert.equal((await agentOnVm()).bundle, 'none');
    console.log('    too old to update itself: the person is told to run the command again');

    console.log('[7] running the command again with --yes installs Codex\'s adapter from the script, and replaces the machine rather than adding a second');
    const remade = await http.post('/mesh/local-agents/join-code', {});
    assert.equal(remade.status, 201, JSON.stringify(remade.data));
    const again = (await ssh(vm, `${(remade.data as { command: string }).command} --yes`)).replace(/\x1b\[[0-9;]*m/g, '');
    assert.match(again, /✓ Codex[^\n]*, through @agentclientprotocol\/codex-acp/, again);
    const rejoined = await until('the machine connecting again', 3, async () => {
      const found = (await machines()).filter((machine) => machine.name === NAME);
      return found.length === 1 && found[0]!.online && found[0]!.connectedAt !== tooOld.connectedAt ? found[0] : undefined;
    });
    assert.equal(rejoined.id, back.id);
    const codex = await until('codex showing ready', 3, async () => (await mine())?.agents.find((agent) => agent.id === 'codex' && agent.state === 'ready'));
    console.log(`    codex ready through its adapter${codex.version ? ` (${codex.version})` : ''}; still one machine, ${rejoined.id}`);
    assert.deepEqual((await until('its agent up to date again', 3, updateIs('current'))).agentUpdate, { state: 'current', current: first, running: first });
    console.log('    the command installed the current agent in place of the old one, and it is up to date');

    console.log('[8] Koala names a bundle its download does not match: the agent refuses it, keeps running as it is, and My Machines says why');
    const installedNow = await agentOnVm();
    const named = 'f'.repeat(64);
    own.exec('backend', `printf '%s  machine-agent.tgz\\n' ${named} > /app/apps/local-agent/dist/machine-agent.tgz.sha256`);
    await onVm('systemctl --user restart koala-machine');
    const refused = await until('My Machines saying the update failed', 3, updateIs('failed'));
    assert.equal(refused.agentUpdate?.current, named);
    assert.equal(refused.agentUpdate?.running, first);
    assert.match(refused.agentUpdate?.reason ?? '', /the agent Koala sent is not the one it named \(its sha256 is [0-9a-f]{12}, Koala named f{12}\)/);
    const kept = await agentOnVm();
    assert.equal(kept.bundle, first, 'the refused update changed the installed agent');
    assert.notEqual(kept.pid, installedNow.pid, 'the agent was not restarted to connect again');
    await sleep(10_000);
    const settled = await agentOnVm();
    assert.equal(settled.active, 'active');
    assert.equal(settled.pid, kept.pid, 'the agent stopped after refusing the update');
    assert.equal(await onVm(`test -e ${AGENT_DIR}.next && echo left || echo clean`), 'clean');
    console.log(`    "${refused.agentUpdate?.reason}"; the agent stays ${first.slice(0, 12)}, still running as pid ${kept.pid}`);

    console.log('[9] Koala is updated and serves a newer agent: the machine, idle, updates itself and comes back as its service on it, and My Machines says it is up to date');
    own.exec('backend', 'sed -i \'s/"version": "1.0.0"/"version": "1.0.1-machine-live"/\' /app/apps/local-agent/package.json');
    await own.restart('backend');
    const newer = await served();
    assert.notEqual(newer, first);
    const seen = new Set<string>();
    const updated = await until('the machine on the newer agent', 5, async () => {
      const found = await updateIs('current', seen)();
      return found?.agentUpdate?.running === newer ? found : undefined;
    });
    assert.deepEqual(updated.agentUpdate, { state: 'current', current: newer, running: newer });
    const after = await agentOnVm();
    assert.equal(after.bundle, newer);
    assert.equal(after.active, 'active');
    assert.notEqual(after.pid, kept.pid, 'the service is still the process that ran before the update');
    assert.equal(await onVm(`cat ${AGENT_DIR}.previous/bundle.sha256`), first, 'the agent before the update was not kept to go back to');
    const version = JSON.parse(await onVm(`node ${AGENT_DIR}/agent.mjs version`)) as { bundle: string; version: string };
    assert.deepEqual(version, { bundle: newer, version: '1.0.1-machine-live' });
    assert.equal(await onVm(`test -e ${AGENT_DIR}.next && echo left || echo clean`), 'clean');
    console.log(`    states seen: ${[...seen].join(' → ')}; now ${newer.slice(0, 12)} (1.0.1-machine-live) as pid ${after.pid}, the one before kept in ${AGENT_DIR}.previous`);

    console.log('[10] a chat on its gemini runs on the updated agent: the large message reaches it through the encrypted, offloaded payloads, and the next turn continues the session');
    const api: Api = async (method, path, body) => {
      const answer = await http.request({ method, url: path, ...(body === undefined ? {} : { data: body }) });
      return { status: answer.status, data: answer.data };
    };
    const said = await chatsOnTheMachine(api, rejoined.id);
    console.log(said.map((line) => `    ${line}`).join('\n'));

    console.log('[11] removing it on My Machines stops its agent, deletes its token, its service and the project it was added with');
    const project = (await db.projects.getProjects()).find((candidate) => candidate.executionTarget?.kind === 'local-device' && candidate.executionTarget.deviceId === rejoined.id);
    assert.ok(project, 'the machine was added without a project');
    assert.equal((await http.delete(`/mesh/local-agents/${rejoined.id}`)).status, 200);
    const stopped = await until('the agent stopping', 2, async () => {
      const state = (await ssh(vm!, 'systemctl --user is-active koala-machine; test -e ~/.config/koala/machine.json && echo token-kept || echo token-gone; test -e ~/.config/systemd/user/koala-machine.service && echo unit-kept || echo unit-gone').catch((err: { stdout?: string }) => err.stdout ?? '')).trim();
      return /^(inactive|failed|unknown)/.test(state) ? state : undefined;
    });
    assert.match(stopped, /token-gone/, stopped);
    assert.match(stopped, /unit-gone/, stopped);
    assert.equal((await db.projects.getProjects()).some((candidate) => candidate.id === project.id), false, 'its project is still there');
    assert.equal(await mine(), undefined, 'it is still listed');
    console.log(`    ${stopped.split('\n').join(', ')}; its project and listing gone`);

    console.log('machine live — PASS');
  }
}

main().then(() => process.exit(0), (err) => {
  console.error(err);
  process.exit(1);
});

import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { encryptValue, type SecretKey, type LocalAgentDeviceMetadata, type ProjectMetadata } from '../../platform/index.js';
import { findDeviceByToken } from '../lib/local-agent-registry.js';
import type { MachineChoice } from '@koala/agent-engine/procedure';
import {
  MACHINE_CODE_TTL_SECONDS, hashMachineCode, machineAgentsFrom, machineChoiceProblem, machineCommand, manualAgentsOf, manualAgentsProblem, newMachineCode,
  type MachineAgent, type ManualMachineAgent,
} from '../lib/machines.js';
import type { MachinesStore } from '../store.js';

type Store = Pick<MachinesStore, 'getLocalAgentDevices' | 'saveMachineJoinCode' | 'takeMachineJoinCode' | 'saveLocalAgentDevice' | 'deleteLocalAgentDevice'>;

export interface MachineSettings {
  url: string;
  temporalAddress: string;
  temporalNamespace: string;
  meshLoginServer?: string | undefined;
}

export interface MachineDevices {
  status(deviceId: string): { online: boolean; connectedAt?: string | undefined; containerMode?: boolean | undefined };
  tell(deviceId: string, event: string): boolean;
  ask<T>(deviceId: string, ownerId: string, event: string, payload: unknown): Promise<T>;
}

export interface MachineDeps {
  store: Store;
  dataKey: SecretKey;
  settings: MachineSettings;
  devices: MachineDevices;
  projects: { register(ownerId: string, name: string, opts: { executionTarget?: ProjectMetadata['executionTarget'] }): Promise<ProjectMetadata> };
  mesh?: { createPreAuthKey(ownerId: string, opts?: { reusable?: boolean; expirySeconds?: number }): Promise<{ key: string }> } | undefined;
  now?: (() => Date) | undefined;
}

export type Outcome<T> = { ok: true; value: T } | { ok: false; status: 400 | 401 | 404 | 409 | 503; error: string };

export interface MachineView {
  id: string;
  name: string;
  rootDir: string;
  os?: string | undefined;
  createdAt: string;
  lastSeenAt?: string | undefined;
  online: boolean;
  connectedAt?: string | undefined;
  containerMode?: boolean | undefined;
  agents: MachineAgent[];
  agentsAt?: string | undefined;
  manualAgents: ManualMachineAgent[];
}

export interface JoinedMachine {
  deviceId: string;
  env: Record<string, string>;
}

const meshUsable = (server: string | undefined): server is string => Boolean(server && !/localhost|127\.0\.0\.1/.test(server));

const text = (value: unknown, limit: number): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, limit) : undefined;

export class MachineService {
  constructor(private readonly deps: MachineDeps) {}

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  private async owned(ownerId: string, id: string): Promise<LocalAgentDeviceMetadata | undefined> {
    return (await this.deps.store.getLocalAgentDevices()).find((device) => device.id === id && device.ownerId === ownerId);
  }

  private view(device: LocalAgentDeviceMetadata): MachineView {
    const status = this.deps.devices.status(device.id);
    return {
      id: device.id,
      name: device.name,
      rootDir: device.rootDir,
      ...(device.os ? { os: device.os } : {}),
      createdAt: device.createdAt,
      ...(device.lastSeenAt ? { lastSeenAt: device.lastSeenAt } : {}),
      online: status.online,
      ...(status.connectedAt ? { connectedAt: status.connectedAt } : {}),
      ...(status.containerMode !== undefined ? { containerMode: status.containerMode } : {}),
      agents: device.agents ?? [],
      ...(device.agentsAt ? { agentsAt: device.agentsAt } : {}),
      manualAgents: device.manualAgents ?? [],
    };
  }

  async choiceProblem(ownerId: string, choice: MachineChoice): Promise<string | undefined> {
    const device = await this.owned(ownerId, choice.deviceId);
    return machineChoiceProblem(device ? this.view(device) : undefined, choice.agent, { model: choice.model });
  }

  async list(ownerId: string): Promise<MachineView[]> {
    return (await this.deps.store.getLocalAgentDevices()).filter((device) => device.ownerId === ownerId).map((device) => this.view(device));
  }

  async createJoinCode(ownerId: string): Promise<{ code: string; command: string; expiresAt: string }> {
    const code = newMachineCode();
    const expiresAt = new Date(this.now().getTime() + MACHINE_CODE_TTL_SECONDS * 1000).toISOString();
    await this.deps.store.saveMachineJoinCode({ hash: hashMachineCode(code), ownerId, expiresAt });
    return { code, expiresAt, command: machineCommand(this.deps.settings.url, code) };
  }

  async join(code: unknown, machine: { hostname?: unknown; rootDir?: unknown; os?: unknown; replaces?: unknown }): Promise<Outcome<JoinedMachine>> {
    if (typeof code !== 'string' || !code) return { ok: false, status: 400, error: 'send the code from My Machines as "code"' };
    const rootDir = text(machine.rootDir, 500);
    if (!rootDir || !path.isAbsolute(rootDir)) return { ok: false, status: 400, error: 'send the folder Koala may work in as "rootDir", a full path' };
    const { settings } = this.deps;
    const mesh = meshUsable(settings.meshLoginServer);
    if (mesh && !this.deps.mesh) return { ok: false, status: 503, error: 'this Koala has a mesh address but cannot reach Headscale to let the machine join it' };
    const found = await this.deps.store.takeMachineJoinCode(hashMachineCode(code));
    if (!found || found.expiresAt <= this.now().toISOString()) return { ok: false, status: 401, error: 'that command has expired or was already used: make a new one on My Machines' };

    const replaced = typeof machine.replaces === 'string' && machine.replaces
      ? findDeviceByToken((await this.deps.store.getLocalAgentDevices()).filter((device) => device.ownerId === found.ownerId), machine.replaces, this.deps.dataKey)
      : undefined;
    const id = replaced?.id ?? uuidv4();
    const token = crypto.randomBytes(32).toString('base64url');
    const name = text(machine.hostname, 80) ?? 'machine';
    const os = text(machine.os, 80);
    const { os: _formerOs, ...kept } = replaced ?? { os: undefined };
    await this.deps.store.saveLocalAgentDevice({
      ...kept,
      id,
      ownerId: found.ownerId,
      name,
      rootDir,
      tokenEnc: encryptValue(token, this.deps.dataKey),
      createdAt: replaced?.createdAt ?? this.now().toISOString(),
      ...(os ? { os } : {}),
    });
    if (!replaced) {
      await this.deps.projects.register(found.ownerId, `${name} - ${path.basename(rootDir) || rootDir}`, { executionTarget: { kind: 'local-device', deviceId: id } })
        .catch((err: Error) => console.warn(`[machines] ${name} joined, but its project could not be made: ${err.message}`));
    }
    const preAuthKey = mesh ? (await this.deps.mesh!.createPreAuthKey(found.ownerId, { reusable: false, expirySeconds: MACHINE_CODE_TTL_SECONDS })).key : '';
    return {
      ok: true,
      value: {
        deviceId: id,
        env: {
          KOALA_BACKEND_URL: settings.url,
          KOALA_DEVICE_ID: id,
          KOALA_DEVICE_TOKEN: token,
          KOALA_ROOT_DIR: rootDir,
          KOALA_TEMPORAL_ADDRESS: settings.temporalAddress,
          KOALA_TEMPORAL_NAMESPACE: settings.temporalNamespace,
          MESH_LOGIN_SERVER: mesh ? settings.meshLoginServer! : '',
          MESH_AUTH_KEY: preAuthKey,
        },
      },
    };
  }

  async recordAgents(deviceId: string, raw: unknown): Promise<void> {
    const device = (await this.deps.store.getLocalAgentDevices()).find((candidate) => candidate.id === deviceId);
    if (!device) return;
    await this.deps.store.saveLocalAgentDevice({ ...device, agents: machineAgentsFrom(raw), agentsAt: this.now().toISOString() });
  }

  async manualAgents(deviceId: string): Promise<ManualMachineAgent[]> {
    const device = (await this.deps.store.getLocalAgentDevices()).find((candidate) => candidate.id === deviceId);
    return device?.manualAgents ?? [];
  }

  async setManualAgents(ownerId: string, deviceId: string, raw: unknown): Promise<Outcome<MachineView>> {
    const device = await this.owned(ownerId, deviceId);
    if (!device) return { ok: false, status: 404, error: 'no such machine' };
    const problem = manualAgentsProblem(raw);
    if (problem) return { ok: false, status: 400, error: problem };
    const next = { ...device, manualAgents: manualAgentsOf(raw) };
    await this.deps.store.saveLocalAgentDevice(next);
    this.deps.devices.tell(deviceId, 'agents:changed');
    return { ok: true, value: this.view(next) };
  }

  async installAdapter(ownerId: string, deviceId: string, agentId: string): Promise<Outcome<{ ok: boolean; output: string }>> {
    const device = await this.owned(ownerId, deviceId);
    if (!device) return { ok: false, status: 404, error: 'no such machine' };
    const agent = (device.agents ?? []).find((candidate) => candidate.id === agentId);
    if (!agent || agent.state !== 'needs-adapter') return { ok: false, status: 409, error: `${agentId} has nothing waiting to be installed on ${device.name}` };
    if (!this.deps.devices.status(deviceId).online) return { ok: false, status: 409, error: `${device.name} is not connected, so nothing can be installed on it` };
    const answer = await this.deps.devices.ask<{ ok?: unknown; output?: unknown }>(deviceId, ownerId, 'agents:install', { id: agentId });
    return { ok: true, value: { ok: answer?.ok === true, output: typeof answer?.output === 'string' ? answer.output : '' } };
  }

  async remove(ownerId: string, deviceId: string): Promise<boolean> {
    const device = await this.owned(ownerId, deviceId);
    if (!device) return false;
    await this.deps.store.deleteLocalAgentDevice(device.id);
    return true;
  }
}

import path from 'path';
import { type ClusterMetadata, type LocalAgentDeviceMetadata, type ProjectMetadata } from '../../platform/index.js';
import { tokenExpired } from '../lib/device-tokens.js';
import type { MachineChoice } from '@koala/agent-engine/procedure';
import {
  machineAgentsFrom, machineChoiceProblem, manualAgentsOf, manualAgentsProblem,
  type MachineAgent, type ManualMachineAgent,
} from '../lib/machines.js';
import type { AccountMachine } from './MachineAccounts.js';
import type { GpuReportOf } from './MachineClusters.js';
import { agentUpdateReportFrom, agentUpdateView, reportedBundle, type AgentUpdateView } from '../lib/agent-updates.js';
import type { MachinesStore } from '../store.js';
import { machineClusterId } from '../lib/machine-clusters.js';

type Store = Pick<MachinesStore, 'getLocalAgentDevices' | 'saveLocalAgentDevice' | 'updateLocalAgentDevice' | 'deleteLocalAgentDevice'>;

export interface MachineAccountSide {
  createJoinCode(ownerId: string): Promise<{ code: string; command: string; expiresAt: string }>;
  remove(ownerId: string, deviceId: string): Promise<boolean>;
}

export interface MachineDevices {
  status(deviceId: string): { online: boolean; connectedAt?: string | undefined };
  tell(deviceId: string, event: string): boolean;
  ask<T>(deviceId: string, ownerId: string, event: string, payload: unknown): Promise<T>;
  drop(deviceId: string): void;
}

export interface MachineDeps {
  store: Store;
  devices: MachineDevices;
  accounts: MachineAccountSide;
  projects: {
    register(ownerId: string, name: string, opts: { executionTarget?: ProjectMetadata['executionTarget'] }): Promise<ProjectMetadata>;
    removeFor?(ownerId: string, deviceId: string): Promise<void>;
  };
  bundle?: { sha256(): Promise<string> } | undefined;
  clusters?: { forget(machine: { id: string; ownerId: string }): Promise<void>; gpuReports(): Promise<Map<string, GpuReportOf>> } | undefined;
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
  tokenExpired: boolean;
  connectedAt?: string | undefined;
  agents: MachineAgent[];
  agentsAt?: string | undefined;
  manualAgents: ManualMachineAgent[];
  agentUpdate?: AgentUpdateView | undefined;
  gpus?: ClusterMetadata['gpus'];
  gpuProblems?: string[] | undefined;
  gpusWithoutDriver?: ClusterMetadata['gpusWithoutDriver'];
}

export class MachineService {
  private readonly forgottenListeners: ((deviceId: string) => void)[] = [];

  constructor(private readonly deps: MachineDeps) {}

  onForgotten(listener: (deviceId: string) => void): void {
    this.forgottenListeners.push(listener);
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  private async owned(ownerId: string, id: string): Promise<LocalAgentDeviceMetadata | undefined> {
    return (await this.deps.store.getLocalAgentDevices()).find((device) => device.id === id && device.ownerId === ownerId);
  }

  private view(device: LocalAgentDeviceMetadata, current?: string): MachineView {
    const status = this.deps.devices.status(device.id);
    const agentUpdate = agentUpdateView(device, current);
    return {
      id: device.id,
      name: device.name,
      rootDir: device.rootDir,
      ...(device.os ? { os: device.os } : {}),
      createdAt: device.createdAt,
      ...(device.lastSeenAt ? { lastSeenAt: device.lastSeenAt } : {}),
      online: status.online,
      tokenExpired: tokenExpired(device, this.now()),
      ...(status.connectedAt ? { connectedAt: status.connectedAt } : {}),
      agents: device.agents ?? [],
      ...(device.agentsAt ? { agentsAt: device.agentsAt } : {}),
      manualAgents: device.manualAgents ?? [],
      ...(agentUpdate ? { agentUpdate } : {}),
    };
  }

  async currentBundle(): Promise<string | undefined> {
    if (!this.deps.bundle) return undefined;
    return this.deps.bundle.sha256().catch((err: Error) => {
      console.warn(`[machines] which machine agent Koala serves is not known: ${err.message}`);
      return undefined;
    });
  }

  async choiceProblem(ownerId: string, choice: MachineChoice): Promise<string | undefined> {
    const device = await this.owned(ownerId, choice.deviceId);
    return machineChoiceProblem(device ? this.view(device) : undefined, choice.agent, { model: choice.model });
  }

  async list(ownerId: string): Promise<MachineView[]> {
    const devices = (await this.deps.store.getLocalAgentDevices()).filter((device) => device.ownerId === ownerId);
    const current = devices.length ? await this.currentBundle() : undefined;
    const reports = devices.length && this.deps.clusters ? await this.deps.clusters.gpuReports() : new Map<string, GpuReportOf>();
    return devices.map((device) => ({ ...this.view(device, current), ...reports.get(machineClusterId(device.id)) }));
  }

  createJoinCode(ownerId: string): Promise<{ code: string; command: string; expiresAt: string }> {
    return this.deps.accounts.createJoinCode(ownerId);
  }



  async seen(deviceId: string): Promise<void> {
    await this.deps.store.updateLocalAgentDevice(deviceId, { set: { lastSeenAt: this.now().toISOString() } });
  }

  async recordAgents(deviceId: string, raw: unknown): Promise<void> {
    const device = (await this.deps.store.getLocalAgentDevices()).find((candidate) => candidate.id === deviceId);
    if (!device) return;
    await this.deps.store.updateLocalAgentDevice(device.id, { set: { agents: machineAgentsFrom(raw), agentsAt: this.now().toISOString() } });
  }

  async recordAgentBundle(deviceId: string, auth: unknown): Promise<void> {
    const bundle = reportedBundle(auth);
    await this.deps.store.updateLocalAgentDevice(deviceId, bundle ? { set: { agentBundle: bundle } } : { unset: ['agentBundle'] });
  }

  async recordAgentUpdate(deviceId: string, raw: unknown): Promise<void> {
    const report = agentUpdateReportFrom(raw, this.now().toISOString());
    if (!report) return;
    await this.deps.store.updateLocalAgentDevice(deviceId, { set: { agentUpdate: report } });
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
    await this.deps.store.updateLocalAgentDevice(device.id, { set: { manualAgents: next.manualAgents } });
    this.deps.devices.tell(deviceId, 'agents:changed');
    return { ok: true, value: this.view(next, await this.currentBundle()) };
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

  remove(ownerId: string, deviceId: string): Promise<boolean> {
    return this.deps.accounts.remove(ownerId, deviceId);
  }

  async adopt(machine: AccountMachine): Promise<void> {
    await this.deps.projects.register(machine.ownerId, `${machine.name} - ${path.basename(machine.rootDir) || machine.rootDir}`, { executionTarget: { kind: 'local-device', deviceId: machine.id } });
  }

  async forget(machine: AccountMachine): Promise<void> {
    this.deps.devices.drop(machine.id);
    for (const listener of this.forgottenListeners) listener(machine.id);
    await this.deps.projects.removeFor?.(machine.ownerId, machine.id);
    await this.deps.clusters?.forget(machine);
  }
}

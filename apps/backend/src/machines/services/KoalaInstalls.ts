import { v4 as uuidv4 } from 'uuid';
import { koalaInstallProgress, type PlacedKoala, type ProvisionReport } from '@koala/engine-core/koala-install';
import { progressOf, type MachineProgress } from '@koala/engine-core/machine-progress';
import type { LocalAgentDeviceMetadata } from '../../platform/index.js';
import { installUnfinished, type InstanceRecord, type PlacingMachine } from '../../instances/index.js';
import { matchDeviceToken } from '../lib/local-agent-registry.js';
import { TOKEN_EXPIRED_SAID } from '../lib/device-tokens.js';
import { FOLLOW_GONE, followingEnded, installFollowing, type InstallFollowing } from '../lib/koala-install-following.js';

export type Outcome<T> = { ok: true; value: T } | { ok: false; status: 400 | 401 | 404 | 409 | 503; error: string };

export type Refusal = Extract<Outcome<never>, { ok: false }>;

export interface InstallPlaces {
  placeOn(ownerId: string, machine: PlacingMachine, requestedName: unknown, installId: string, move: boolean): Promise<Outcome<{ instanceId: string; replaces?: string | undefined }>>;
  placedKoala(installId: string, machine: PlacingMachine): Promise<Outcome<PlacedKoala>>;
  installOf(installId: string): Promise<InstanceRecord | undefined>;
  installedUrl(instance: InstanceRecord, raw: unknown): Promise<Outcome<string>>;
  installsOn(machineId: string): Promise<InstanceRecord[]>;
  installNotStarted(instanceId: string, installId: string, why: string): Promise<void>;
}

export interface InstallWorkflows {
  start(installId: string, ownerId: string): Promise<void>;
  progress(installId: string, progress: MachineProgress): Promise<void>;
  setup(installId: string, report: ProvisionReport): Promise<void>;
  reconnected(installId: string): Promise<void>;
  cancel(installId: string): Promise<void>;
}

export interface InstallFollower {
  told(following: InstallFollowing): void;
  broke(err: Error): void;
}

interface Following {
  deviceId: string;
  listener: InstallFollower;
  last?: string | undefined;
  looking: Promise<void>;
  over: boolean;
  stop(): void;
}

export interface KoalaInstallsDeps {
  devices(): Promise<LocalAgentDeviceMetadata[]>;
  places(): InstallPlaces | undefined;
  workflows: InstallWorkflows;
  toMachines: { placeKoala(deviceId: string, placed: PlacedKoala): Promise<boolean> };
  toOwner: { installChanged(ownerId: string): void };
  newId?: (() => string) | undefined;
  now?: (() => Date) | undefined;
}

const NO_PLACES = 'this Koala does not put Koala on machines';
const NO_SUCH_INSTALL = 'no such install of Koala on this machine';

const placing = (device: LocalAgentDeviceMetadata): PlacingMachine => ({ id: device.id, name: device.name, ...(device.meshIp ? { meshIp: device.meshIp } : {}) });

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export class KoalaInstalls {
  private readonly relayed = new Map<string, string>();
  private readonly following = new Map<string, Set<Following>>();

  constructor(private readonly deps: KoalaInstallsDeps) {}

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  private unfinishedOn = async (machineId: string): Promise<InstanceRecord[]> => {
    const places = this.deps.places();
    if (!places) return [];
    return (await places.installsOn(machineId)).filter((instance) => installUnfinished(instance.install));
  };

  async start(ownerId: string, device: LocalAgentDeviceMetadata, requestedName: unknown, move = false, refused: (refusal: Refusal) => Promise<void> = async () => undefined): Promise<Outcome<{ installId: string }>> {
    const places = this.deps.places();
    if (!places) return { ok: false, status: 503, error: NO_PLACES };
    const installId = (this.deps.newId ?? uuidv4)();
    const placed = await places.placeOn(ownerId, placing(device), requestedName, installId, move);
    if (!placed.ok) {
      await refused(placed);
      return placed;
    }
    if (placed.value.replaces) await this.deps.workflows.cancel(placed.value.replaces);
    try {
      await this.deps.workflows.start(installId, ownerId);
    } catch (err) {
      const why = `root could not start putting Koala on ${device.name}: ${reasonOf(err)}`;
      await refused({ ok: false, status: 503, error: why });
      await places.installNotStarted(placed.value.instanceId, installId, why);
      this.changed(ownerId);
      return { ok: false, status: 503, error: why };
    }
    this.changed(ownerId);
    return { ok: true, value: { installId } };
  }

  async follow(token: string | undefined, listener: InstallFollower): Promise<Outcome<{ stop(): void }>> {
    const device = await this.deviceOf(token);
    if (!device.ok) return device;
    if (!this.deps.places()) return { ok: false, status: 503, error: NO_PLACES };
    const ownerId = device.value.ownerId;
    const followers = this.following.get(ownerId) ?? new Set<Following>();
    const follower: Following = {
      deviceId: device.value.id,
      listener,
      looking: Promise.resolve(),
      over: false,
      stop: () => {
        follower.over = true;
        followers.delete(follower);
        if (followers.size === 0 && this.following.get(ownerId) === followers) this.following.delete(ownerId);
      },
    };
    followers.add(follower);
    this.following.set(ownerId, followers);
    this.look(follower);
    return { ok: true, value: { stop: follower.stop } };
  }

  wake(ownerId: string): void {
    for (const follower of [...(this.following.get(ownerId) ?? [])]) this.look(follower);
  }

  private look(follower: Following): void {
    const stop = follower.stop;
    follower.looking = follower.looking.then(async () => {
      if (follower.over) return;
      const places = this.deps.places();
      if (!places) throw new Error(NO_PLACES);
      const device = (await this.deps.devices()).find((candidate) => candidate.id === follower.deviceId);
      const read = installFollowing(device, device ? await places.installsOn(device.id) : []);
      const now: InstallFollowing = read.kind === 'none' && follower.last !== undefined ? { kind: 'stopped', why: FOLLOW_GONE } : read;
      const said = JSON.stringify(now);
      if (follower.over || said === follower.last) return;
      follower.last = said;
      if (followingEnded(now)) stop();
      follower.listener.told(now);
    }).catch((err: unknown) => {
      stop();
      follower.listener.broke(err instanceof Error ? err : new Error(String(err)));
    });
  }

  private changed(ownerId: string): void {
    this.deps.toOwner.installChanged(ownerId);
    this.wake(ownerId);
  }

  private async deviceOf(token: string | undefined): Promise<Outcome<LocalAgentDeviceMetadata>> {
    if (!token) return { ok: false, status: 401, error: 'send this machine\'s own token as the bearer credential' };
    const match = matchDeviceToken(await this.deps.devices(), token, this.now());
    if (!match) return { ok: false, status: 401, error: 'this machine is not one of Koala\'s: run the command from My Machines again' };
    if (match.expired) return { ok: false, status: 401, error: TOKEN_EXPIRED_SAID };
    return { ok: true, value: match.device };
  }

  async report(installId: string, token: string | undefined, body: unknown): Promise<Outcome<{ recorded: true }>> {
    const device = await this.deviceOf(token);
    if (!device.ok) return device;
    const places = this.deps.places();
    if (!places) return { ok: false, status: 503, error: NO_PLACES };
    const instance = await places.installOf(installId);
    if (!instance?.install || instance.install.machineId !== device.value.id) return { ok: false, status: 404, error: NO_SUCH_INSTALL };
    if (!installUnfinished(instance.install)) return { ok: false, status: 409, error: `that install has ended ${instance.install.state}` };
    const read = progressOf(body, koalaInstallProgress(Boolean(instance.install.move)));
    if (!read.ok) return { ok: false, status: 400, error: read.problem };
    let progress = read.value;
    if (progress.url !== undefined) {
      const url = await places.installedUrl(instance, progress.url);
      if (!url.ok) return url;
      progress = { ...progress, url: url.value };
    }
    return this.handed(() => this.deps.workflows.progress(installId, progress));
  }

  async setupHeard(installId: string, report: ProvisionReport): Promise<Outcome<{ recorded: true }>> {
    return this.handed(() => this.deps.workflows.setup(installId, report));
  }

  async progressHeard(installId: string, progress: MachineProgress): Promise<Outcome<{ recorded: true }>> {
    return this.handed(() => this.deps.workflows.progress(installId, progress));
  }

  private async handed(hand: () => Promise<void>): Promise<Outcome<{ recorded: true }>> {
    try {
      await hand();
    } catch (err) {
      return { ok: false, status: 503, error: `root could not hand this to the install it follows: ${reasonOf(err)}` };
    }
    return { ok: true, value: { recorded: true } };
  }

  async connected(deviceId: string): Promise<void> {
    for (const instance of await this.unfinishedOn(deviceId)) await this.deps.workflows.reconnected(instance.install!.id);
  }

  async machineRemoved(deviceId: string): Promise<void> {
    for (const instance of await this.unfinishedOn(deviceId)) await this.deps.workflows.cancel(instance.install!.id);
  }

  async relay(instance: InstanceRecord): Promise<void> {
    this.changed(instance.ownerId);
    const install = instance.install;
    if (!install?.askedAt || !installUnfinished(install) || this.relayed.get(install.id) === install.askedAt) return;
    this.relayed.set(install.id, install.askedAt);
    const device = (await this.deps.devices()).find((candidate) => candidate.id === install.machineId);
    const places = this.deps.places();
    if (!device || !places) return;
    const placed = await places.placedKoala(install.id, placing(device));
    if (!placed.ok && placed.status === 404) return;
    if (!placed.ok) throw new Error(`${device.name} could not be asked to put Koala on itself: ${placed.error}`);
    await this.deps.toMachines.placeKoala(device.id, placed.value);
  }
}

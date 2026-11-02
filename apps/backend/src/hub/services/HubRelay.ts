import { randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { HubRole } from '../lib/hub.js';
import type { RelayOp } from '../lib/hub-board.js';

export interface RelayCaller {
  personId: string;
  email: string;
  role: HubRole;
}

export interface RelayCall {
  id: string;
  projectId: string;
  op: RelayOp;
  args: Record<string, unknown>;
  as: RelayCaller;
  upload?: { stream: Readable; type: string; size?: number | undefined } | undefined;
}

export type RelayAnswer =
  | { kind: 'json'; status: number; body: unknown }
  | { kind: 'stream'; status: number; type: string; name?: string | undefined; size?: number | undefined; stream: Readable };

export interface InstanceLine {
  call(call: RelayCall): void;
  changed(projectId: string): void;
}

export class InstanceOffline extends Error {
  constructor(why = 'The owner\'s instance is offline, so this cannot be read until it is back.') {
    super(why);
    this.name = 'InstanceOffline';
  }
}

interface Pending {
  call: RelayCall;
  line: InstanceLine;
  resolve: (answer: RelayAnswer) => void;
  reject: (err: Error) => void;
}

export class HubRelay {
  private readonly lines = new Map<string, Set<InstanceLine>>();
  private readonly pending = new Map<string, Pending>();

  connect(instanceId: string, line: InstanceLine): () => void {
    const lines = this.lines.get(instanceId) ?? new Set<InstanceLine>();
    lines.add(line);
    this.lines.set(instanceId, lines);
    return () => this.disconnect(instanceId, line);
  }

  private disconnect(instanceId: string, line: InstanceLine): void {
    const lines = this.lines.get(instanceId);
    lines?.delete(line);
    if (lines?.size === 0) this.lines.delete(instanceId);
    for (const [callId, entry] of this.pending) {
      if (entry.line !== line) continue;
      this.pending.delete(callId);
      entry.reject(new InstanceOffline('The owner\'s instance went offline before it answered.'));
    }
  }

  online(instanceId: string | undefined): boolean {
    return Boolean(instanceId && this.lines.get(instanceId)?.size);
  }

  call(instanceId: string | undefined, projectId: string, op: RelayOp, args: Record<string, unknown>, as: RelayCaller, upload?: RelayCall['upload']): Promise<RelayAnswer> {
    const line = instanceId ? this.lines.get(instanceId)?.values().next().value : undefined;
    if (!line) return Promise.reject(new InstanceOffline());
    return new Promise<RelayAnswer>((resolve, reject) => {
      const call: RelayCall = { id: randomBytes(12).toString('hex'), projectId, op, args, as, ...(upload ? { upload } : {}) };
      this.pending.set(call.id, { call, line, resolve, reject });
      line.call(call);
    });
  }

  changed(instanceId: string | undefined, projectId: string): void {
    for (const line of (instanceId ? this.lines.get(instanceId) : undefined) ?? []) line.changed(projectId);
  }

  callOf(callId: string): RelayCall | undefined {
    return this.pending.get(callId)?.call;
  }

  answer(callId: string, answer: RelayAnswer): boolean {
    const entry = this.pending.get(callId);
    if (!entry) return false;
    this.pending.delete(callId);
    entry.resolve(answer);
    return true;
  }
}

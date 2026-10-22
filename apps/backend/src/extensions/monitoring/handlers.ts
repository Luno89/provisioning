import { randomUUID } from 'node:crypto';
import type { ToolHandler, ToolOutcome } from '@koala/engine-core';
import { sameAction, type ActionProposal } from '../../engine/lib/action-proposals.js';
import { alertSpec, isAlertKind } from '../../monitoring/lib/monitoring-alerts.js';
import type { MonitoringService, Viewer } from '../../monitoring/services/MonitoringService.js';
import { APP_HEALTH, CLUSTER_HEALTH, MONITORING_OVERVIEW, PROPOSE_ALERT } from './catalogue.js';

export interface MonitoringReading {
  monitoring: Pick<MonitoringService, 'describeOverview' | 'describeApp' | 'describeCluster' | 'proposeAlertProblem'>;
  rules: (ownerId: string) => Promise<Array<{ id: string; summary: string; deploymentId: string }>>;
  viewer: (ownerId: string) => Promise<Viewer>;
}

export interface MonitoringToolDeps {
  reading?: MonitoringReading | undefined;
  proposals: { list(ownerId: string): Promise<ActionProposal[]>; save(proposal: ActionProposal): Promise<void> };
  now?: (() => string) | undefined;
  newId?: (() => string) | undefined;
}

const refuse = (reason: string): ToolOutcome => ({ ok: false, digest: reason, content: reason });
const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
const number = (value: unknown): number | undefined => {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : undefined;
};
const failure = (err: unknown): ToolOutcome => refuse((err as Error).message);

export function createMonitoringTools(deps: MonitoringToolDeps): Record<string, ToolHandler> {
  const now = deps.now ?? (() => new Date().toISOString());
  const newId = deps.newId ?? randomUUID;
  const UNREADABLE = refuse('monitoring cannot be read here');

  return {
    async [MONITORING_OVERVIEW]({ caller }): Promise<ToolOutcome> {
      if (!caller.ownerId) return refuse('this run has no owner whose apps could be read');
      const reading = deps.reading;
      if (!reading) return UNREADABLE;
      try {
        const content = await reading.monitoring.describeOverview(await reading.viewer(caller.ownerId));
        return { ok: true, digest: content.split('\n')[0] ?? 'read', content };
      } catch (err) { return failure(err); }
    },

    async [APP_HEALTH]({ parsed, caller }): Promise<ToolOutcome> {
      if (!caller.ownerId) return refuse('this run has no owner whose apps could be read');
      const app = text((parsed ?? {} as Record<string, unknown>).app);
      if (!app) return refuse('name the app');
      const reading = deps.reading;
      if (!reading) return UNREADABLE;
      try {
        const content = await reading.monitoring.describeApp(await reading.viewer(caller.ownerId), app);
        return { ok: true, digest: content.split('\n')[0] ?? 'read', content };
      } catch (err) { return failure(err); }
    },

    async [CLUSTER_HEALTH]({ parsed, caller }): Promise<ToolOutcome> {
      if (!caller.ownerId) return refuse('this run has no owner whose clusters could be read');
      const cluster = text((parsed ?? {} as Record<string, unknown>).cluster);
      if (!cluster) return refuse('name the cluster');
      const reading = deps.reading;
      if (!reading) return UNREADABLE;
      try {
        const content = await reading.monitoring.describeCluster(await reading.viewer(caller.ownerId), cluster);
        return { ok: true, digest: content.split('\n')[0] ?? 'read', content };
      } catch (err) { return failure(err); }
    },

    async [PROPOSE_ALERT]({ parsed, caller }): Promise<ToolOutcome> {
      if (!caller.ownerId) return refuse('this run has no owner to propose for');
      const args = (parsed ?? {}) as Record<string, unknown>;
      const appName = text(args.app);
      const why = text(args.why);
      if (!appName) return refuse('name the app');
      if (!why) return refuse('say why, for the person to read on the card');
      const reading = deps.reading;
      if (!reading) return UNREADABLE;
      const viewer = await reading.viewer(caller.ownerId);
      const remove = text(args.remove);

      let params: Record<string, string>;
      let summary: string;
      if (remove) {
        const rule = (await reading.rules(caller.ownerId)).find((entry) => entry.id === remove);
        if (!rule) return refuse(`no alert has the id ${remove}; app_health lists the ids`);
        params = { remove };
        summary = `Stop alerting: ${rule.summary}`;
      } else {
        const kind = text(args.kind);
        if (!isAlertKind(kind)) return refuse(`kind is one of down, slow, memory, restarts, volume, errors`);
        const spec = alertSpec(kind, number(args.threshold), number(args.forMinutes));
        if ('error' in spec) return refuse(spec.error);
        const checked = await reading.monitoring.proposeAlertProblem(viewer, appName, spec);
        if ('error' in checked) return refuse(`${checked.error}; nothing was proposed`);
        params = { deploymentId: checked.dep.id, kind: spec.kind, threshold: String(spec.threshold), forMinutes: String(spec.forMinutes) };
        summary = checked.summary;
      }

      const open = (await deps.proposals.list(caller.ownerId)).find((entry) => entry.status === 'proposed' && sameAction(entry, 'set_alert', params));
      if (open) return { ok: true, digest: `already proposed: ${open.summary}`, content: `This is already waiting for the person on a card (${open.summary}); nothing new was proposed.` };
      const stamp = now();
      await deps.proposals.save({
        id: newId(),
        ownerId: caller.ownerId,
        kind: 'set_alert',
        summary,
        why,
        detail: [summary, remove ? 'The alert stops firing and is removed from its cluster.' : 'When it fires you get a notice in the project\'s channel (or this conversation) and it shows on the Monitoring page.'],
        params,
        status: 'proposed',
        ...(caller.conversationId ? { conversationId: caller.conversationId } : {}),
        ...(caller.runId ? { runId: caller.runId } : {}),
        createdAt: stamp,
        updatedAt: stamp,
      });
      return { ok: true, digest: `proposed: ${summary}`, content: `Proposed on a card: ${summary}. Nothing is set until the person applies it.` };
    },
  };
}

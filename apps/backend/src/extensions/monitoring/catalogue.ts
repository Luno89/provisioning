import type { ToolDefinition } from '@koala/agent-engine';
import { ALERT_KINDS, ALERT_RULES } from '../../monitoring/lib/monitoring-alerts.js';

export const MONITORING_OVERVIEW = 'monitoring_overview';
export const APP_HEALTH = 'app_health';
export const CLUSTER_HEALTH = 'cluster_health';
export const PROPOSE_ALERT = 'propose_alert';

const kindLines = ALERT_KINDS.map((kind) => {
  const rule = ALERT_RULES[kind];
  return `${kind}${rule.threshold ? ` (threshold in ${rule.threshold.unit}, default ${rule.threshold.default})` : ''}, for ${rule.forMinutes} minutes by default`;
}).join('; ');

export const MONITORING_TOOLS: ToolDefinition[] = [
  {
    name: MONITORING_OVERVIEW,
    summary: 'See what needs attention across every cluster and app the person has, read from each cluster\'s monitoring',
    guidance: 'Use this when the person asks how things are going in general, or before saying anything about their apps\' health. It lists what needs attention first, then each app and cluster with its state. For one app or cluster in detail, use app_health or cluster_health.',
    binding: 'platform',
    effect: 'read',
    idempotent: true,
    openWorld: false,
    returns: 'what needs attention (each app or cluster with its state and why), then every app and every cluster with its state, then Koala itself: which of its processes report, its requests, model calls and failed work',
    failures: [{ when: 'a cluster cannot be reached or is still getting its monitoring', says: 'so, as that cluster\'s state, with the rest read as usual' }],
    parameters: { type: 'object', properties: {} },
  },
  {
    name: APP_HEALTH,
    summary: 'Read how one of the person\'s apps is doing: up or down, uptime, response time, requests and failures, memory and CPU, restarts, volumes, alerts and releases',
    guidance: 'Use this when the person asks how an app is performing, why it is slow or down, or before proposing an alert on it. Name the app as the person or monitoring_overview names it. Say what is not measured as not measured, never as fine.',
    binding: 'platform',
    effect: 'read',
    idempotent: true,
    openWorld: false,
    returns: 'the app\'s state and why, uptime over the last day, week and the history kept, response time, requests and the share failing (when counted), memory and CPU against their limits, restarts, its fullest volume, alerts firing and recent, the alerts set on it with their ids, and releases in the last day',
    failures: [
      { when: 'no app of the person has that name or id', says: 'the names they have' },
      { when: 'the app\'s cluster cannot be reached or is still getting its monitoring', says: 'which' },
    ],
    parameters: {
      type: 'object',
      properties: { app: { type: 'string', description: 'The app\'s name or id.' } },
      required: ['app'],
    },
  },
  {
    name: CLUSTER_HEALTH,
    summary: 'Read how one of the person\'s clusters is doing: its machines, CPU, memory and disk in use, pods not running, alerts, its apps, and how much history it keeps',
    guidance: 'Use this when the person asks about a cluster or machine, or when an app\'s trouble may come from where it runs (a full disk, memory used up).',
    binding: 'platform',
    effect: 'read',
    idempotent: true,
    openWorld: false,
    returns: 'the cluster\'s state and why, its machines, CPU, memory and disk in use, pods not running, alerts firing, its apps with their states, and the days of history it keeps',
    failures: [{ when: 'no cluster of the person has that name or id', says: 'the names they have' }],
    parameters: {
      type: 'object',
      properties: { cluster: { type: 'string', description: 'The cluster\'s name or id.' } },
      required: ['cluster'],
    },
  },
  {
    name: PROPOSE_ALERT,
    summary: 'Propose an alert on one of the person\'s apps, or on Koala itself, or removing one, for the person to apply on a card',
    guidance: `Use this when the person wants to be told when something happens to an app, or to Koala itself (app "koala", kinds koala_down, model_errors and workflow_failures, only for whoever runs this Koala). Kinds: ${kindLines}. Pick the kind that matches what they said, and a threshold and minutes only when they gave them. A firing alert reaches them as a notice in the project's channel (or this conversation for an app with no project) and on the Monitoring page. To remove one, give remove with the id app_health lists. Nothing is set until the person applies the card.`,
    binding: 'platform',
    effect: 'propose',
    idempotent: true,
    openWorld: false,
    returns: 'that it is on a card for the person, or that the same card is already waiting',
    failures: [
      { when: 'no app of the person has that name, the kind is unknown, the threshold is out of range, or failing requests are asked for on an app whose requests are not counted', says: 'which' },
      { when: 'the app\'s cluster cannot be reached now', says: 'so' },
    ],
    parameters: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'The app\'s name or id, or "koala" for Koala itself.' },
        kind: { type: 'string', enum: [...ALERT_KINDS], description: 'What to watch for; koala_down, model_errors and workflow_failures are about Koala itself.' },
        threshold: { type: 'number', description: 'The level that fires it, in the kind\'s unit. Optional.' },
        forMinutes: { type: 'number', description: 'How long it must last before it fires. Optional.' },
        remove: { type: 'string', description: 'The id of an alert to remove instead, as app_health lists it.' },
        why: { type: 'string', description: 'Why, shown to the person on the card.' },
      },
      required: ['app', 'why'],
    },
  },
];

import type { EngineExtension } from '@koala/agent-engine/procedure';
import { APP_HEALTH, CLUSTER_HEALTH, MONITORING_OVERVIEW, MONITORING_TOOLS, PROPOSE_ALERT } from './catalogue.js';

export const MONITORING: EngineExtension = {
  id: 'monitoring',
  title: 'Monitoring',
  describe: 'How the person\'s apps and clusters are doing, read from each cluster\'s Prometheus, and alerts on their apps proposed on a card.',
  version: '1',
  requires: ['platform'],
  operations: [],
  tools: MONITORING_TOOLS,
  personas: [],
  grants: { koala: [MONITORING_OVERVIEW, APP_HEALTH, CLUSTER_HEALTH, PROPOSE_ALERT] },
  procedures: [],
};

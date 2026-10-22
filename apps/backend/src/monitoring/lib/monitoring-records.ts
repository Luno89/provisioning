import type { AlertAbout } from './monitoring-alerts.js';

export interface MonitoringSetting {
  clusterId: string;
  ownerId: string;
  historyDays: number;
  updatedAt: string;
  appliedAt?: string | undefined;
  problem?: string | undefined;
}

export interface AlertEpisode {
  id: string;
  ownerId: string;
  clusterId: string;
  key: string;
  name: string;
  summary: string;
  about: AlertAbout;
  ruleId?: string | undefined;
  startedAt: string;
  resolvedAt?: string | undefined;
}

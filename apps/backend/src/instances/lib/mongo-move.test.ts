import { describe, expect, it } from 'vitest';
import { CLUSTER_FIELDS, retargetedCluster } from './mongo-move.js';

describe('the records a move renames onto the machine\'s cluster', () => {
  it('are every field a stored record names a cluster by', () => {
    expect(CLUSTER_FIELDS).toEqual({
      conversations: ['messages[].notice.refs.clusterId'],
      deployments: ['clusterId'],
      monitoringAlertEpisodes: ['clusterId'],
      monitoringAlertRules: ['clusterId'],
      monitoringSettings: ['clusterId'],
      projects: ['targetClusterId'],
      provisioning: ['target.clusterId'],
    });
  });

  it('move each record that names the pool\'s cluster, and only those, to the machine\'s', () => {
    const from = 'pool-bo';
    const to = 'machine-desk';
    expect(retargetedCluster(from, to)).toEqual([
      { kind: 'set', collection: 'conversations', filter: { 'messages.notice.refs.clusterId': from }, update: { $set: { 'messages.$[moved].notice.refs.clusterId': to } }, arrayFilters: [{ 'moved.notice.refs.clusterId': from }] },
      { kind: 'set', collection: 'deployments', filter: { clusterId: from }, update: { $set: { clusterId: to } } },
      { kind: 'set', collection: 'monitoringAlertEpisodes', filter: { clusterId: from }, update: { $set: { clusterId: to } } },
      { kind: 'set', collection: 'monitoringAlertRules', filter: { clusterId: from }, update: { $set: { clusterId: to } } },
      { kind: 'rekey', collection: 'monitoringSettings', from, to },
      { kind: 'set', collection: 'projects', filter: { targetClusterId: from }, update: { $set: { targetClusterId: to } } },
      { kind: 'set', collection: 'provisioning', filter: { 'target.clusterId': from }, update: { $set: { 'target.clusterId': to } } },
    ]);
  });
});

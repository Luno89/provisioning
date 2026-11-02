import { beforeEach, describe, expect, it } from 'vitest';
import { matches, mock, type MockProxy } from 'vitest-mock-extended';
import type { Principal } from '../../platform/lib/permissions.js';
import { callRouter, PERSON } from '../testing/call-router.js';
import { MonitoringError, type MonitoringService } from '../services/MonitoringService.js';
import { monitoringRouter } from './monitoring.js';

let monitoring: MockProxy<MonitoringService>;
const router = () => monitoringRouter({ monitoring });
const call = (path: string, method: 'GET' | 'PUT' | 'DELETE' = 'GET', body?: unknown) => callRouter(router(), '/api/monitoring', { method, path, body });
const theirs = matches<Principal>((principal) => principal.id === PERSON.id);

beforeEach(() => {
  monitoring = mock<MonitoringService>();
});

describe('/api/monitoring', () => {
  it('gives the overview for the person asking', async () => {
    monitoring.overview.calledWith(theirs).mockResolvedValue({ apps: [], clusters: [], attention: [], firing: [] } as never);
    expect(await call('/')).toMatchObject({ status: 200, body: { apps: [], clusters: [] } });
  });

  it('gives the alerts for the person asking', async () => {
    monitoring.alerts.calledWith(theirs).mockResolvedValue({ firing: [], history: [], rules: [] } as never);
    expect(await call('/alerts')).toMatchObject({ status: 200, body: { firing: [] } });
  });

  it('gives an app\'s health over the range asked, 24 hours otherwise', async () => {
    monitoring.appHealth.mockResolvedValue({ lines: [] } as never);
    await call('/apps/books?range=7d');
    await call('/apps/books?range=forever');
    await call('/apps/books');
    expect(monitoring.appHealth.mock.calls.map(([, id, range]) => [id, range])).toEqual([['books', '7d'], ['books', '24h'], ['books', '24h']]);
  });

  it('gives a cluster\'s health over the range asked, 24 hours otherwise', async () => {
    monitoring.clusterHealth.mockResolvedValue({ lines: [] } as never);
    await call('/clusters/c1?range=1h');
    await call('/clusters/c1?range=nope');
    expect(monitoring.clusterHealth.mock.calls.map(([viewer, id, range]) => [viewer.id, id, range])).toEqual([[PERSON.id, 'c1', '1h'], [PERSON.id, 'c1', '24h']]);
  });

  it('sets how long a cluster keeps its history from the body\'s days', async () => {
    monitoring.setHistory.mockResolvedValue({ days: 30, applied: false, can: ['change'] });
    expect(await call('/clusters/c1/history', 'PUT', { days: 30 })).toMatchObject({ status: 200, body: { days: 30 } });
    expect(monitoring.setHistory).toHaveBeenCalledWith(theirs, 'c1', 30);
  });

  it('removes an alert rule and answers with nothing', async () => {
    monitoring.removeRule.mockResolvedValue(undefined);
    expect(await call('/rules/r1', 'DELETE')).toMatchObject({ status: 204, text: '' });
    expect(monitoring.removeRule).toHaveBeenCalledWith(theirs, 'r1');
  });

  it('answers with the status and words the service refused with', async () => {
    monitoring.appHealth.mockRejectedValue(new MonitoringError(404, 'no app of yours has that id'));
    monitoring.setHistory.mockRejectedValue(new MonitoringError(400, 'days is a whole number'));
    expect(await call('/apps/nope')).toMatchObject({ status: 404, body: { error: 'no app of yours has that id' } });
    expect(await call('/clusters/c1/history', 'PUT', { days: 'ten' })).toMatchObject({ status: 400, body: { error: 'days is a whole number' } });
  });
});

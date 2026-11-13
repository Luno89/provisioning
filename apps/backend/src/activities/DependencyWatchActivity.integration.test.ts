import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { hostWorkerSettingsFrom } from '../platform/index.js';
import { testIdentityKey, testKeyEnv } from '../platform/testing/keys.js';
import { testDatabaseAt } from '../platform/lib/test-database.js';
import { testDataDir } from '../platform/testing/data-dir.js';
import { smtpSink, textOf, type SmtpSink } from '../platform/testing/smtp-sink.js';
import { startDependencySourcesStandIn, type DependencySourcesStandIn } from '../platform/testing/dependency-sources-stand-in.js';
import { giveHostActivities, hostClusterAccess } from './host-settings.js';
import { DependencyWatchActivity } from './DependencyWatchActivity.js';

const TAG = 'watched';
const k3s = { 'bom-ref': 'binary:pkg:generic/k3s@v1.36.4+k3s1', name: 'k3s', version: 'v1.36.4+k3s1', properties: [{ name: 'koala:kind', value: 'binary' }, { name: 'koala:osv-ecosystem', value: 'Go' }, { name: 'koala:osv-name', value: 'github.com/k3s-io/k3s' }, { name: 'koala:github', value: 'k3s-io/k3s' }, { name: 'koala:released', value: '2026-09-01T00:00:00Z' }] };
const advisory = { id: 'GO-k3s', summary: 'GO-k3s summary', database_specific: { severity: 'CRITICAL' }, affected: [{ package: { ecosystem: 'Go', name: 'github.com/k3s-io/k3s' }, ranges: [{ events: [{ introduced: '0' }, { fixed: '1.36.5+k3s1' }] }] }] };

let mail: SmtpSink;
let sources: DependencySourcesStandIn;
let mongoUri: string;
let db: Awaited<ReturnType<typeof testDatabaseAt>>['db'];

beforeAll(async () => {
  mail = await smtpSink();
  sources = await startDependencySourcesStandIn({
    found: { 'github.com/k3s-io/k3s@1.36.4+k3s1': ['GO-k3s'] },
    records: { 'GO-k3s': advisory },
    answers: { '/github/repos/k3s-io/k3s/releases/tags/v1.36.5%2Bk3s1': { published_at: '2026-10-25T00:00:00Z' } },
  });
  const at = await testDatabaseAt();
  db = at.db;
  mongoUri = at.uri.replace(/\/[^/?]*(\?|$)/, `/${at.dbName}$1`);
  await db.accounts.saveUser({ id: 'operator-1', email: 'operator@root.test', roles: ['operator'], createdAt: '2026-10-01T00:00:00Z' } as never);
  await db.accounts.saveUser({ id: 'person-1', email: 'person@root.test', createdAt: '2026-10-01T00:00:00Z' } as never);
});
afterAll(async () => { await sources.close(); await mail.close(); });

describe('root\'s daily dependency check, run as the host worker runs it', () => {
  it('reads the inventory of the release root runs from its data folder, asks the sources it is given, and emails root\'s operators what it found', async () => {
    const dataDir = testDataDir();
    mkdirSync(join(dataDir, 'instance-charts'), { recursive: true });
    writeFileSync(join(dataDir, 'instance-charts', `${TAG}.sbom.json`), JSON.stringify({ components: [k3s] }));
    const settings = hostWorkerSettingsFrom({
      NODE_ENV: 'development', ...testKeyEnv('dependency-watch'), ROLE: 'root', ROOT_IDENTITY_KEY: testIdentityKey(), MONGO_URI: mongoUri,
      TEMPORAL_CONNECTION_ADDRESS: inject('temporalAddress'), TEMPORAL_NAMESPACE: 'default', TEMPORAL_TLS_CA: '/nowhere/ca.crt', DATA_DIR: dataDir,
      HEALTH_PORT: '0', TEMPORAL_METRICS_PORT: '0', PUBLIC_URL: 'https://app.root.test', INSTANCE_IMAGE_TAG: TAG,
      MAIL_SMTP_URL: mail.url, MAIL_FROM: 'koala@root.test', DEPENDENCY_SOURCES: sources.url,
    });
    giveHostActivities(settings, hostClusterAccess(settings));

    expect(await DependencyWatchActivity()).toEqual({ findings: 1, due: 1 });

    expect(sources.asked).toEqual(expect.arrayContaining(['POST /osv/querybatch', 'GET /osv/vulns/GO-k3s', 'GET /github/repos/k3s-io/k3s/releases/tags/v1.36.5%2Bk3s1']));
    expect(mail.received.map((message) => message.to)).toEqual([['operator@root.test']]);
    expect(mail.subjectOf(mail.received[0]!)).toBe('Koala\'s dependencies: 1 new advisory');
    expect(textOf(mail.received[0]!)).toContain('k3s@v1.36.4+k3s1: GO-k3s (critical); fixed in 1.36.5+k3s1, published 2026-10-25: update it now');
  });
});

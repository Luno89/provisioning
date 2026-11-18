import { fileURLToPath } from 'node:url';
import { clusterAccessFrom, InfrastructureService, terraformPlacesFor } from '../infrastructure/index.js';
import { platformServicesSettingsFrom } from '../platform/index.js';
import { provisionPlatformServices } from '../activities/platform-provision.js';

async function main(): Promise<void> {
  const settings = platformServicesSettingsFrom(process.env);
  const access = clusterAccessFrom(settings.clusters, { role: settings.role.role });
  const infra = new InfrastructureService(terraformPlacesFor(settings.terraform, settings.dataDir, settings.clusters.chartSources));
  await provisionPlatformServices({ access, infra }, {
    reach: access.own(),
    koalaNamespace: settings.podNamespace,
    pool: Boolean(settings.clusters.here.poolName),
    dataDir: settings.dataDir,
    crawl4aiToken: settings.crawl4aiToken,
  }, (line) => console.log(`[platform] ${line}`));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err: Error) => {
    console.error(`[platform] ${err.message}`);
    process.exitCode = 1;
  });
}

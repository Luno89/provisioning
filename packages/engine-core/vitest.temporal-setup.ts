import type { TestProject } from 'vitest/node';
import { startTestTemporal } from './testing/temporal.js';
import { makeCertificates } from './testing/temporal-tls.js';

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const certificates = makeCertificates();
  const server = await startTestTemporal(certificates);
  project.provide('temporalAddress', server.address);
  project.provide('temporalTlsAddress', server.tlsAddress);
  project.provide('temporalCa', certificates.caPath);
  return () => server.close();
}

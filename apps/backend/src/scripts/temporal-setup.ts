import { fileURLToPath } from 'node:url';
import { connectTemporal } from '@koala/engine-core/temporal';
import { setUpTemporal, temporalDial, temporalSetupSettingsFrom } from '../platform/index.js';

const SUBJECT = 'koala-temporal-setup';

export async function temporalSetupStep(env: Readonly<Record<string, string | undefined>>, say: (line: string) => void): Promise<void> {
  const settings = temporalSetupSettingsFrom(env);
  const connection = await connectTemporal(temporalDial(SUBJECT, settings), 'client');
  try {
    await setUpTemporal(connection, settings.temporal.namespace, settings.keys.temporal, SUBJECT, say);
  } finally {
    await connection.close();
  }
  say(`[setup] Temporal's namespace ${settings.temporal.namespace} is set up with the search attributes Koala uses`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  temporalSetupStep(process.env, (line) => console.log(line)).catch((err: Error) => {
    console.error(`[setup] ${err.message}`);
    process.exitCode = 1;
  });
}

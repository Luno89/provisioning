import { proxyActivities } from '../temporal.js';

const { Ready } = proxyActivities<{ Ready(): Promise<void> }>();

export async function awaitReady(): Promise<void> {
  await Ready();
}

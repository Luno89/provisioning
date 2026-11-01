import { proxyActivities } from '../temporal.js';
import { awaitReady } from './shared.js';

const { Greet } = proxyActivities<{ Greet(name: string): Promise<string> }>();
const steps = proxyActivities<{ Count(): Promise<number> }>();

export async function DemoWorkflow(name: string): Promise<string> {
  await awaitReady();
  return `${await Greet(name)} ${await steps.Count()}`;
}

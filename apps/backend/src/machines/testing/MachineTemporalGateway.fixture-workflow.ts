import { proxyActivities } from '@temporalio/workflow';

const onMachine = (deviceId: string) => proxyActivities<{ Echo(text: string): Promise<string> }>({
  taskQueue: `device-${deviceId}`,
  startToCloseTimeout: '1 minute',
  heartbeatTimeout: '30 seconds',
  retry: { maximumAttempts: 1 },
});

export async function askMachine(deviceId: string, text: string): Promise<string> {
  return onMachine(deviceId).Echo(text);
}

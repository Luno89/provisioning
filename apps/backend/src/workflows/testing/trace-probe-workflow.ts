import { continueAsNew, executeChild, proxyActivities, proxyLocalActivities } from '@temporalio/workflow';

export interface TraceProbeActivities {
  Probe(label: string): Promise<void>;
}

export interface TraceProbeInput {
  readonly label: string;
  readonly continueOnce: boolean;
}

const remote = proxyActivities<TraceProbeActivities>({ startToCloseTimeout: '1 minute' });
const local = proxyLocalActivities<TraceProbeActivities>({ startToCloseTimeout: '1 minute' });

export async function traceProbeChildWorkflow(label: string): Promise<void> {
  await remote.Probe(`${label} child activity`);
}

export async function traceProbeWorkflow(input: TraceProbeInput): Promise<void> {
  await remote.Probe(`${input.label} activity`);
  await local.Probe(`${input.label} local activity`);
  await executeChild(traceProbeChildWorkflow, { args: [input.label] });
  if (input.continueOnce) await continueAsNew<typeof traceProbeWorkflow>({ label: `${input.label} continued`, continueOnce: false });
}

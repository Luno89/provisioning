import { ParentClosePolicy, condition, continueAsNew, defineSignal, setHandler, startChild, workflowInfo } from '@temporalio/workflow';
import { nameProject } from '../telemetry-interceptors.js';

export const finishProbe = defineSignal('finishProbe');

export interface ProjectProbeInput {
  readonly continueOnce: boolean;
  readonly late?: string | undefined;
}

const finished = async (): Promise<void> => {
  let done = false;
  setHandler(finishProbe, () => { done = true; });
  await condition(() => done);
};

export async function projectProbeChildWorkflow(): Promise<void> {
  await finished();
}

export async function projectProbeWorkflow(input: ProjectProbeInput): Promise<void> {
  if (input.late) nameProject(input.late);
  const id = workflowInfo().workflowId;
  if (input.continueOnce) {
    await startChild(projectProbeChildWorkflow, { workflowId: `${id}-abandoned`, parentClosePolicy: ParentClosePolicy.ABANDON });
    await continueAsNew<typeof projectProbeWorkflow>({ continueOnce: false });
  }
  const child = await startChild(projectProbeChildWorkflow, { workflowId: `${id}-child`, parentClosePolicy: ParentClosePolicy.REQUEST_CANCEL });
  await finished();
  await child.signal(finishProbe);
  await child.result();
}

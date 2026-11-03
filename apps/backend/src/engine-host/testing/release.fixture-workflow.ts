import { condition, defineSignal, setHandler } from '@temporalio/workflow';

const answer = defineSignal<[{ nodeId: string; value: string }]>('answer');
const cancelRun = defineSignal('cancelRun');

export async function releaseStandIn(): Promise<string> {
  let decided: string | undefined;
  setHandler(answer, ({ value }) => { decided = value; });
  setHandler(cancelRun, () => { decided = 'stopped'; });
  await condition(() => decided !== undefined);
  return decided ?? '';
}

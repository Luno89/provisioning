import { condition, defineQuery, defineSignal, setHandler } from '@temporalio/workflow';

const answer = defineSignal<[{ nodeId: string; value: string }]>('answer');
const cancelRun = defineSignal('cancelRun');
const answered = defineQuery<string[]>('answered');

export async function releaseAwaitingPerson(): Promise<string[]> {
  const answers: string[] = [];
  let stopped = false;
  setHandler(answer, ({ nodeId, value }) => { answers.push(`${nodeId}: ${value}`); });
  setHandler(cancelRun, () => { stopped = true; });
  setHandler(answered, () => answers);
  await condition(() => stopped);
  return answers;
}

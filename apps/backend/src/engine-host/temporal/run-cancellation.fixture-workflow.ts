import { condition, defineSignal, setHandler } from '@temporalio/workflow';

export const finish = defineSignal('finish');

export async function heldRun(): Promise<string> {
  let done = false;
  setHandler(finish, () => { done = true; });
  await condition(() => done);
  return 'done';
}

export type Checked<Ready, Outcome> = { refused: Outcome } | { ready: Ready };

export interface CheckedCallSteps<Ready, Outcome> {
  check(): Promise<Checked<Ready, Outcome>>;
  run(ready: Ready): Promise<Outcome>;
  shown(outcome: Outcome, ready: Ready): Promise<Outcome>;
}

export async function checkedCall<Ready, Outcome>(steps: CheckedCallSteps<Ready, Outcome>): Promise<Outcome> {
  const checked = await steps.check();
  if ('refused' in checked) return checked.refused;
  return steps.shown(await steps.run(checked.ready), checked.ready);
}

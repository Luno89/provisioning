export interface Answer {
  finding: string;
  state: 'asked' | 'noted';
  at: string;
  why: string;
}

export const ANSWERS: Answer[] = [
  { finding: 'missing:B6', state: 'noted', at: '2026-11-06T23:42', why: 'The Mac is after v1, so no code does it yet; told to the owner with the drift report, who answered "continue plz".' },
  { finding: 'missing:I1', state: 'noted', at: '2026-11-06T23:42', why: 'The map knows a script only by the Koala API calls it makes, and dev.sh makes none; a limit of the map, told to the owner with the drift report.' },
  { finding: 'missing:I2', state: 'noted', at: '2026-11-06T23:42', why: 'This computer joined as a GPU machine waits on dev running production\'s shape, which is v1 work; told to the owner with the drift report.' },
];

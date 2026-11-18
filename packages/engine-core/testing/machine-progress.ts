import { describe, expect, it } from 'vitest';
import { progressCases, type ProgressContract } from '../src/machine-progress.js';

export interface ProgressSide {
  credential(): Promise<string>;
  post(credential: string | undefined, body: unknown): Promise<number>;
}

export function machineProgressContract(name: string, contract: ProgressContract, make: () => Promise<ProgressSide>): void {
  const cases = progressCases(contract);
  describe(`${name} hearing a machine's progress`, () => {
    it('takes each stage\'s state from the machine holding the credential', async () => {
      const side = await make();
      const credential = await side.credential();
      for (const body of cases.accepted) expect([body, await side.post(credential, body)]).toEqual([body, 204]);
    });

    it('refuses a body outside the contract with 400', async () => {
      const side = await make();
      const credential = await side.credential();
      for (const { body } of cases.refused) expect([body, await side.post(credential, body)]).toEqual([body, 400]);
    });

    it('refuses with 401 a credential it did not give, or none', async () => {
      const side = await make();
      const credential = await side.credential();
      const [body] = cases.accepted;
      expect(await side.post(`${credential}-not`, body)).toBe(401);
      expect(await side.post(undefined, body)).toBe(401);
    });
  });
}

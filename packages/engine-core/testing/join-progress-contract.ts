import { describe, expect, it } from 'vitest';
import { JOIN_PROGRESS_CASES } from '../src/join-progress.js';

export interface JoinProgressSide {
  code: string;
  post(credential: string | undefined, body: unknown): Promise<number>;
}

export function joinProgressContract(name: string, make: () => Promise<JoinProgressSide>): void {
  describe(`${name} hearing a machine's join progress`, () => {
    it('takes each stage\'s state from the machine holding the join code', async () => {
      const side = await make();
      for (const body of JOIN_PROGRESS_CASES.accepted) expect([body, await side.post(side.code, body)]).toEqual([body, expect.toSatisfy((status: number) => status >= 200 && status < 300)]);
    });

    it('refuses a body outside the contract with 400', async () => {
      const side = await make();
      for (const { body } of JOIN_PROGRESS_CASES.refused) expect([body, await side.post(side.code, body)]).toEqual([body, 400]);
    });

    it('refuses with 401 a code it did not give, or none', async () => {
      const side = await make();
      const [body] = JOIN_PROGRESS_CASES.accepted;
      expect(await side.post(`${side.code}-not`, body)).toBe(401);
      expect(await side.post(undefined, body)).toBe(401);
    });
  });
}

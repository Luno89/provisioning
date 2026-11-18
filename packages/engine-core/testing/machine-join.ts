import { describe, expect, it } from 'vitest';
import { JOIN_PROGRESS_CASES } from '../src/machine-join.js';

export interface JoinProgressSide {
  code(): Promise<string>;
  post(code: string | undefined, body: unknown): Promise<number>;
}

export function joinProgressContract(name: string, make: () => Promise<JoinProgressSide>): void {
  describe(`${name} hearing a machine's join progress`, () => {
    it('takes each stage\'s state from the machine holding the join code', async () => {
      const side = await make();
      const code = await side.code();
      for (const body of JOIN_PROGRESS_CASES.accepted) expect([body, await side.post(code, body)]).toEqual([body, 204]);
    });

    it('refuses a body outside the contract with 400', async () => {
      const side = await make();
      const code = await side.code();
      for (const { body } of JOIN_PROGRESS_CASES.refused) expect([body, await side.post(code, body)]).toEqual([body, 400]);
    });

    it('refuses with 401 a code it did not give, or none', async () => {
      const side = await make();
      const code = await side.code();
      const [body] = JOIN_PROGRESS_CASES.accepted;
      expect(await side.post(`${code}-not`, body)).toBe(401);
      expect(await side.post(undefined, body)).toBe(401);
    });
  });
}

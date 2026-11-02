import { isDeepStrictEqual } from 'node:util';
import { matches } from 'vitest-mock-extended';

export const equalTo = <T>(expected: T) => matches<T>((actual) => isDeepStrictEqual(actual, expected));

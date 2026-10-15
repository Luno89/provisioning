import { Agent } from 'undici';

export const PATIENT_DISPATCHER = new Agent({ headersTimeout: 0, bodyTimeout: 0, connect: { timeout: 0 } });

export const patientFetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
  globalThis.fetch(input, { ...init, dispatcher: PATIENT_DISPATCHER } as unknown as RequestInit)) as typeof fetch;

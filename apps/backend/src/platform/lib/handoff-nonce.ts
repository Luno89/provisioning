const NONCE = /^[A-Za-z0-9_-]{32}$/;

export const handoffNonceShaped = (value: unknown): value is string => typeof value === 'string' && NONCE.test(value);

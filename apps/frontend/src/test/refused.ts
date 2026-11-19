export const refused = (status: number, data: unknown): Error & { isAxiosError: true; response: { status: number; data: unknown } } =>
  Object.assign(new Error(`Request failed with status code ${status}`), { isAxiosError: true as const, response: { status, data } })

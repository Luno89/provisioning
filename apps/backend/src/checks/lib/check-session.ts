const SESSION_COOKIE = /^(?:__Host-)?session=([^;]+)/;

export function sessionCookieFrom(setCookie: readonly string[] | string | undefined): string | undefined {
  const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const cookie of cookies) {
    const found = SESSION_COOKIE.exec(cookie);
    if (found) return `session=${found[1]}`;
  }
  return undefined;
}

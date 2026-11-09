import type { Request, Response } from 'express';

const SESSION_COOKIE = 'session';
const cookieNamed = (name: string, secure: boolean): string => (secure ? `__Host-${name}` : name);
const getCookie = (req: Request, name: string): string | undefined => (req as unknown as { cookies: Record<string, string> }).cookies[name];

export function signIn(res: Response): void {
  res.cookie(cookieNamed(SESSION_COOKIE, true), 'token');
}

export function guard(req: Request): string | undefined {
  const name = cookieNamed(SESSION_COOKIE, true);
  return getCookie(req, name);
}

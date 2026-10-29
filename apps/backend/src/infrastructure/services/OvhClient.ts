import { ovhErrorMessage, ovhHeaders, type OvhKeys } from '../lib/ovh-api.js';
import { ovhHostFor } from '../lib/vps-catalog/adapters.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface OvhAccount extends OvhKeys {
  subsidiary: string;
}

export class OvhError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export class OvhClient {
  readonly host: string;
  private drift: number | undefined;

  constructor(private readonly account: OvhAccount, private readonly fetchImpl: FetchLike = fetch, private readonly now: () => number = Date.now) {
    this.host = ovhHostFor(account.subsidiary);
  }

  get subsidiary(): string {
    return this.account.subsidiary.trim().toUpperCase();
  }

  private async timestamp(): Promise<number> {
    if (this.drift === undefined) {
      const answer = await this.fetchImpl(`${this.host}/auth/time`);
      if (!answer.ok) throw new OvhError(answer.status, ovhErrorMessage(answer.status, await answer.json().catch(() => undefined)));
      const serverTime = Number(await answer.json());
      this.drift = Number.isFinite(serverTime) ? serverTime - Math.floor(this.now() / 1000) : 0;
    }
    return Math.floor(this.now() / 1000) + this.drift;
  }

  async call<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
    const url = `${this.host}${path}`;
    const text = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = { ...ovhHeaders(this.account, method, url, text, await this.timestamp()), Accept: 'application/json' };
    if (text) headers['Content-Type'] = 'application/json';
    const answer = await this.fetchImpl(url, { method, headers, ...(text ? { body: text } : {}) });
    const raw = await answer.text();
    const parsed: unknown = raw ? (() => { try { return JSON.parse(raw); } catch { return raw; } })() : undefined;
    if (!answer.ok) throw new OvhError(answer.status, ovhErrorMessage(answer.status, parsed));
    return parsed as T;
  }

  get<T>(path: string): Promise<T> { return this.call<T>('GET', path); }
  post<T>(path: string, body?: unknown): Promise<T> { return this.call<T>('POST', path, body); }
  delete<T>(path: string): Promise<T> { return this.call<T>('DELETE', path); }
}

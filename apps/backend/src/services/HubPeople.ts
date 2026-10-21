import { HUB_AUDIENCE } from '../lib/hub.js';
import { issueMoveToken, type IdentityKeyPair } from '../lib/identity-token.js';
import type { HubService } from './HubService.js';

export interface HubPeople {
  blockers(personId: string): Promise<string[]>;
  letGo(personId: string): Promise<void>;
}

export const hubPersonPart = (personId: string, what: 'leaving' | 'let-go'): string => `people/${personId}/${what}`;

export function localHubPeople(hub: HubService): HubPeople {
  return {
    blockers: async (personId) => (await hub.leaving(personId)).blockers,
    letGo: async (personId) => { await hub.letGo(personId); },
  };
}

export class RemoteHubPeople implements HubPeople {
  constructor(private readonly hub: { url: string; signing: IdentityKeyPair }, private readonly fetchImpl: typeof fetch = fetch) {}

  private async ask(method: 'GET' | 'DELETE', personId: string, what: 'leaving' | 'let-go'): Promise<Record<string, unknown>> {
    const token = issueMoveToken(this.hub.signing, HUB_AUDIENCE, hubPersonPart(personId, what));
    const response = await this.fetchImpl(`${this.hub.url}/api/hub-root/people/${encodeURIComponent(personId)}`, { method, headers: { authorization: `Bearer ${token}` } });
    const answer = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new Error(`the hub would not ${what === 'leaving' ? 'say what this account is on' : 'let this account go'} (${response.status}): ${String(answer.error ?? 'no reason given')}`);
    return answer;
  }

  async blockers(personId: string): Promise<string[]> {
    const answer = await this.ask('GET', personId, 'leaving');
    return Array.isArray(answer.blockers) ? answer.blockers.map(String) : [];
  }

  async letGo(personId: string): Promise<void> {
    await this.ask('DELETE', personId, 'let-go');
  }
}

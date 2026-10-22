import type { InviteSender } from './HubService.js';

export class HubRootClient implements InviteSender {
  constructor(private readonly root: { rootUrl: string; credential: string }, private readonly fetchImpl: typeof fetch = fetch) {}

  async send(request: Parameters<InviteSender['send']>[0]): ReturnType<InviteSender['send']> {
    const response = await this.fetchImpl(`${this.root.rootUrl}/api/hub-link/invite`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.root.credential}` },
      body: JSON.stringify(request),
    });
    const answer = await response.json().catch(() => ({})) as { link?: string; emailed?: boolean; why?: string; error?: string };
    if (!response.ok || !answer.link) throw new Error(`root would not send the invite (${response.status}): ${answer.error ?? 'no reason given'}`);
    return { link: answer.link, emailed: Boolean(answer.emailed), ...(answer.why ? { why: answer.why } : {}) };
  }
}

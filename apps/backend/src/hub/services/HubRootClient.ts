import type { InviteSender } from './HubService.js';
import { refusalOf } from './hub-answers.js';

export class HubRootClient implements InviteSender {
  constructor(private readonly root: { rootUrl: string; token: () => Promise<string> }, private readonly fetchImpl: typeof fetch = fetch) {}

  async send(request: Parameters<InviteSender['send']>[0], inviter: Parameters<InviteSender['send']>[1]): ReturnType<InviteSender['send']> {
    const inviterToken = await inviter.vouch?.();
    if (!inviterToken) throw new Error('root takes an invite only from someone it signed in to the hub; sign in again');
    const { email, projectName, role, join } = request;
    const response = await this.fetchImpl(`${this.root.rootUrl}/api/hub-link/invite`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await this.root.token()}` },
      body: JSON.stringify({ email, projectName, role, join, inviterToken }),
    });
    const answer = (response.ok ? await response.json() : await refusalOf(response)) as { link?: string; emailed?: boolean; why?: string; error?: string };
    if (response.status === 429 && answer.error) return { refused: answer.error };
    if (!response.ok || !answer.link) throw new Error(`root would not send the invite (${response.status}): ${answer.error ?? 'no reason given'}`);
    return { link: answer.link, emailed: Boolean(answer.emailed), ...(answer.why ? { why: answer.why } : {}) };
  }
}

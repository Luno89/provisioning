import { mailVerdict, type MailVerdict, type MailWindow } from '../lib/instance-mail-limit.js';

export class InstanceMailLimit {
  private readonly windows = new Map<string, MailWindow>();

  constructor(private readonly now: () => number = Date.now) {}

  take(instanceId: string): MailVerdict {
    const verdict = mailVerdict(this.windows.get(instanceId), this.now());
    this.windows.set(instanceId, verdict.window);
    return verdict;
  }
}

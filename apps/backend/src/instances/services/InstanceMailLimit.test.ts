import { describe, expect, it } from 'vitest';
import { InstanceMailLimit } from './InstanceMailLimit.js';
import { INSTANCE_MAIL_PER_HOUR } from '../lib/instance-mail-limit.js';

describe('how much mail root sends for each instance', () => {
  it('lets an instance send up to its hourly allowance and then holds the rest back, telling its owner once', () => {
    const limit = new InstanceMailLimit(() => 1_000_000);
    for (let sent = 0; sent < INSTANCE_MAIL_PER_HOUR; sent += 1) expect(limit.take('inst-1').send).toBe(true);
    const first = limit.take('inst-1');
    expect(first).toMatchObject({ send: false, tell: true, until: 1_000_000 + 60 * 60 * 1000 });
    expect(limit.take('inst-1')).toMatchObject({ send: false, tell: false });
  });

  it('counts each instance on its own', () => {
    const limit = new InstanceMailLimit(() => 1_000_000);
    for (let sent = 0; sent < INSTANCE_MAIL_PER_HOUR; sent += 1) limit.take('inst-1');
    expect(limit.take('inst-2').send).toBe(true);
  });

  it('lets mail through again once an hour has passed', () => {
    let now = 0;
    const limit = new InstanceMailLimit(() => now);
    for (let sent = 0; sent < INSTANCE_MAIL_PER_HOUR; sent += 1) limit.take('inst-1');
    expect(limit.take('inst-1').send).toBe(false);
    now = 60 * 60 * 1000 + 1;
    expect(limit.take('inst-1').send).toBe(true);
  });

  it('reads the real clock when it is not given one', () => {
    expect(new InstanceMailLimit().take('inst-1').send).toBe(true);
  });
});

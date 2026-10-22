import { describe, expect, it } from 'vitest';
import { alertMail, emailWanted, mailProblem } from './mail.js';
import { emailWayFrom } from './email-way.js';
import type { AlertEpisode } from '../../monitoring/lib/monitoring-records.js';

const episode: AlertEpisode = { id: 'e1', ownerId: 'o', clusterId: 'c', key: 'k', name: 'Koala_down', summary: 'books has not answered for 5 minutes', about: { kind: 'app', deploymentId: 'books' }, startedAt: '2026-10-17T10:00:00Z' };

describe('which alerts are emailed', () => {
  it('sends every one, only the ones that say something is down, or none', () => {
    expect(emailWanted('all', { name: 'NodeMemoryHighUtilization' })).toBe(true);
    expect(emailWanted('down', { name: 'NodeMemoryHighUtilization' })).toBe(false);
    expect(emailWanted('down', { name: 'Koala_down' })).toBe(true);
    expect(emailWanted('down', { name: 'AppProbeDown' })).toBe(true);
    expect(emailWanted('off', { name: 'AppProbeDown' })).toBe(false);
  });
});

describe('an alert email', () => {
  it('says what fired and links to the app\'s health', () => {
    const mail = alertMail(episode, 'fired', 'https://app.koala.dev/');
    expect(mail.subject).toBe('Alert: books has not answered for 5 minutes');
    expect(mail.text).toContain('See its health: https://app.koala.dev/#/monitoring/app/books');
  });

  it('says when it resolved', () => {
    expect(alertMail({ ...episode, resolvedAt: '2026-10-17T10:09:00Z' }, 'resolved', undefined)).toMatchObject({ subject: 'Resolved: books has not answered for 5 minutes', text: expect.stringContaining('resolved at 2026-10-17T10:09:00Z') });
  });
});

describe('a message an instance asks root to send', () => {
  it('has a one-line subject and some text', () => {
    expect(mailProblem({ subject: 'Hi', text: 'there' })).toBeUndefined();
    expect(mailProblem({ subject: 'Hi\r\nBcc: someone@else', text: 'x' })).toBe('subject is one line');
    expect(mailProblem({ subject: 'Hi', text: '' })).toBe('text is up to 20000 characters');
  });
});

describe('how a backend sends email', () => {
  it('sends through SMTP when it is set up, from the platform\'s domain', () => {
    expect(emailWayFrom({ MAIL_SMTP_URL: 'smtp://127.0.0.1:2525', INGRESS_DOMAIN: 'koala.dev' }, { role: 'root' })).toEqual({ kind: 'smtp', url: 'smtp://127.0.0.1:2525', from: 'Koala <alerts@koala.dev>' });
  });

  it('says why it cannot when nothing is set up', () => {
    expect(emailWayFrom({}, { role: 'combined' })).toEqual({ kind: 'none', why: 'email is not set up on this platform (MAIL_SMTP_URL is unset)' });
  });

  it('asks root on an instance, never sending itself', () => {
    expect(emailWayFrom({ MAIL_SMTP_URL: 'smtp://x', INSTANCE_CREDENTIAL: 'cred' }, { role: 'instance', instance: { id: 'i1', ownerId: 'o', rootUrl: 'https://app.koala.dev' } })).toEqual({ kind: 'root', rootUrl: 'https://app.koala.dev', instanceId: 'i1', credential: 'cred' });
  });
});

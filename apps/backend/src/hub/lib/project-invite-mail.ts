import type { MailMessage } from '../../platform/lib/mail.js';

const ROLE_SAID: Record<string, string> = {
  owner: 'an owner, who can do everything on it',
  collaborator: 'a collaborator, who works on it and approves changes',
  client: 'a client, who sees how it is going and asks for changes',
};

export function projectInviteMail(input: { inviterEmail: string; projectName: string; role: string; link: string }): MailMessage {
  const project = input.projectName.replace(/[\r\n]+/g, ' ').slice(0, 120);
  return {
    subject: `${input.inviterEmail} invited you to ${project} on Koala`,
    text: [
      `${input.inviterEmail} invited you to the project "${project}" on Koala, as ${ROLE_SAID[input.role] ?? input.role}.`,
      '',
      `Open this link to join: ${input.link}`,
      '',
      'It works only for this email address. If you were not expecting it, you can ignore this email.',
    ].join('\n'),
  };
}

export const joinLink = (rootUrl: string, code: string, join: string): string =>
  `${rootUrl.replace(/\/+$/, '')}/#/join?code=${encodeURIComponent(code)}&project=${encodeURIComponent(join)}`;

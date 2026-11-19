import { X509Certificate } from 'node:crypto';

export function gatewayServerName(certificate: string | Buffer): string {
  const named = /(?:^|\n)CN=([^\n]+)/.exec(new X509Certificate(certificate).subject)?.[1]?.trim();
  if (!named) throw new Error('the machine gateway\'s certificate names no server, so a machine would have nothing to check it by; give it the certificate the install\'s Temporal holds');
  return named;
}

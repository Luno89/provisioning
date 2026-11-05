import net from 'node:net';
import type { AddressInfo } from 'node:net';

export interface Received { from: string; to: string[]; data: string }

export interface SmtpSink {
  url: string;
  received: Received[];
  subjectOf(message: Received): string | undefined;
  close(): Promise<void>;
}

export const headerOf = (message: Received, name: string): string | undefined =>
  new RegExp(`^${name}: (.*)$`, 'mi').exec(message.data)?.[1]?.trim();

export async function smtpSink(): Promise<SmtpSink> {
  const received: Received[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    let buffer = '';
    let current: Received = { from: '', to: [], data: '' };
    let inData = false;
    socket.write('220 sink ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          current.data = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          received.push(current);
          current = { from: '', to: [], data: '' };
          socket.write('250 queued\r\n');
          continue;
        }
        const eol = buffer.indexOf('\r\n');
        if (eol < 0) return;
        const line = buffer.slice(0, eol);
        buffer = buffer.slice(eol + 2);
        const verb = line.split(' ')[0]!.toUpperCase();
        if (verb === 'EHLO' || verb === 'HELO') socket.write('250 sink\r\n');
        else if (verb === 'MAIL') { current.from = /<([^>]*)>/.exec(line)?.[1] ?? ''; socket.write('250 ok\r\n'); }
        else if (verb === 'RCPT') { current.to.push(/<([^>]*)>/.exec(line)?.[1] ?? ''); socket.write('250 ok\r\n'); }
        else if (verb === 'DATA') { inData = true; socket.write('354 go\r\n'); }
        else if (verb === 'QUIT') { socket.end('221 bye\r\n'); return; }
        else socket.write('250 ok\r\n');
      }
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return {
    url: `smtp://127.0.0.1:${(server.address() as AddressInfo).port}`,
    received,
    subjectOf: (message) => headerOf(message, 'Subject'),
    close: () => new Promise<void>((done) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => done());
    }),
  };
}

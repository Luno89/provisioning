import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';

export interface TestCertificates {
  ca: string;
  cert: string;
  key: string;
  serverName: string;
}

const SERVER_NAME = 'koala-temporal';

export function makeCertificates(): TestCertificates {
  const dir = mkdtempSync(join(tmpdir(), 'koala-agent-temporal-tls-'));
  const openssl = (args: string[]): void => { execFileSync('openssl', args, { stdio: 'ignore' }); };
  openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', join(dir, 'ca.key')]);
  openssl(['req', '-x509', '-new', '-key', join(dir, 'ca.key'), '-sha256', '-days', '1', '-subj', '/CN=Koala test CA', '-out', join(dir, 'ca.crt')]);
  openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', join(dir, 'server.key')]);
  openssl(['req', '-new', '-key', join(dir, 'server.key'), '-subj', `/CN=${SERVER_NAME}`, '-out', join(dir, 'server.csr')]);
  writeFileSync(join(dir, 'ext'), `subjectAltName=DNS:${SERVER_NAME}\nextendedKeyUsage=serverAuth\nkeyUsage=digitalSignature\n`);
  openssl(['x509', '-req', '-in', join(dir, 'server.csr'), '-CA', join(dir, 'ca.crt'), '-CAkey', join(dir, 'ca.key'), '-CAcreateserial', '-CAserial', join(dir, 'ca.srl'), '-days', '1', '-sha256', '-extfile', join(dir, 'ext'), '-out', join(dir, 'server.crt')]);
  return { ca: readFileSync(join(dir, 'ca.crt'), 'utf8'), cert: readFileSync(join(dir, 'server.crt'), 'utf8'), key: readFileSync(join(dir, 'server.key'), 'utf8'), serverName: SERVER_NAME };
}

export function tlsInFrontOf(address: string, certificates: TestCertificates): Promise<{ address: string; close(): Promise<void> }> {
  const port = Number(address.slice(address.lastIndexOf(':') + 1));
  const open = new Set<net.Socket>();
  const server = tls.createServer({ key: certificates.key, cert: certificates.cert, ALPNProtocols: ['h2'] }, (secured) => {
    const plain = net.connect(port, '127.0.0.1');
    open.add(secured);
    open.add(plain);
    secured.pipe(plain).pipe(secured);
    const end = (): void => { secured.destroy(); plain.destroy(); open.delete(secured); open.delete(plain); };
    secured.on('error', end);
    plain.on('error', end);
    secured.on('close', end);
    plain.on('close', end);
  });
  return new Promise((ready) => server.listen(0, '127.0.0.1', () => ready({
    address: `127.0.0.1:${(server.address() as net.AddressInfo).port}`,
    close: () => new Promise<void>((done) => {
      server.close(() => done());
      for (const socket of open) socket.destroy();
    }),
  })));
}

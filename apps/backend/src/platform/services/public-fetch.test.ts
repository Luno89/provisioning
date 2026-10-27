import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NotPublicError, publicAddressProblem, publicFetch } from './public-fetch.js';

let server: http.Server;
let port = 0;
let reached = 0;

beforeAll(async () => {
  server = http.createServer((_req, res) => { reached += 1; res.end('internal'); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('fetching from the open internet', () => {
  it('never reaches this machine or the private network, by address or by a name that resolves there', async () => {
    await expect(publicFetch(`http://127.0.0.1:${port}/`)).rejects.toThrow(NotPublicError);
    await expect(publicFetch(`http://localhost:${port}/`)).rejects.toThrow(/localhost resolves to (127\.0\.0\.1|::1) is (a private|not a public)/);
    await expect(publicFetch('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(NotPublicError);
    await expect(publicFetch('file:///etc/passwd')).rejects.toThrow(/file: is not http or https/);
    expect(reached).toBe(0);
  });

  it('says why an address would be refused before anything is sent there', async () => {
    expect(await publicAddressProblem(`http://localhost:${port}`)).toMatch(/private, loopback|not a public/);
    expect(await publicAddressProblem('http://10.1.2.3/')).toMatch(/private/);
    expect(await publicAddressProblem('http://user:pw@93.184.216.34/')).toMatch(/name and password/);
    expect(await publicAddressProblem('http://93.184.216.34/')).toBeUndefined();
  });
});

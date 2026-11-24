import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { temporalJwks } from '../platform/lib/temporal-auth.js';
import { testKeyEnv } from '../platform/testing/keys.js';
import { COMPOSE, REPO, rootServicesWorld } from '../platform/testing/root-services-world.js';
import { rootServices, rootServicesHere } from './root-services.js';

const env = { ...process.env, ...testKeyEnv('root-services-entry') };
const made: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const down of made.splice(0)) await down();
});

function terminal(): { write: (text: string) => void; shown: () => string } {
  let text = '';
  return { write: (more) => { text += more; }, shown: () => text };
}

describe('npm run root-services, the entry dev and the host start root\'s services with', () => {
  it('runs root\'s services from the compose files of the checkout it is in, keeping Temporal\'s keys in its data folder', () => {
    const here = rootServicesHere();
    expect([here.temporal.files, here.mongo.files, here.headscale.files, here.registry.files]).toEqual(['temporal', 'mongo', 'headscale', 'registry'].map((name) => [`${REPO}/docker-compose.${name}.yml`]));
    expect([here.temporal.tlsDir, here.temporal.jwksFile]).toEqual([`${REPO}/apps/backend/data/temporal-tls`, `${REPO}/apps/backend/data/temporal-keys/temporal-jwks.json`]);
  });

  it('starts Temporal with its certificate and the platform\'s key, shows each step done, and shows each already done the next time', async () => {
    const { places, down } = await rootServicesWorld();
    made.push(down);

    const first = terminal();
    expect(await rootServices(['--compose', COMPOSE, 'temporal'], { places, env, terminal: first })).toBe(true);
    expect(first.shown()).toMatch(/\[1\] Temporal's certificate, signed by a CA of its own\n[\s\S]*  done\n\n\[2\] The key Temporal checks Koala's tokens with\n[\s\S]*  done\n\n\[3\] Temporal, answering over TLS\n[\s\S]*  done\n\n\[4\] Temporal's namespace \S+ and the search attributes Koala uses\n[\s\S]*  done\n$/);
    expect(JSON.parse(readFileSync(places.temporal.jwksFile, 'utf8'))).toEqual(temporalJwks(env.TEMPORAL_KEY!));

    const again = terminal();
    expect(await rootServices(['--compose', COMPOSE, 'temporal'], { places, env, terminal: again })).toBe(true);
    expect(again.shown().match(/ {2}already done\n/g)).toHaveLength(4);
  }, 0);

  it('says why a service could not start and answers that it failed, so the entry exits non-zero', async () => {
    const { places, down } = await rootServicesWorld();
    made.push(down);
    const taken: Server = createServer();
    const port = Number(new URL(places.headscale.url).port);
    await new Promise<void>((done) => taken.listen(port, '127.0.0.1', done));
    try {
      const shown = terminal();
      expect(await rootServices(['--compose', COMPOSE, 'headscale'], { places, env, terminal: shown })).toBe(false);
      expect(shown.shown()).toMatch(/\[1\] Headscale, the mesh's coordination server\n[\s\S]*  failed: .+\n$/);
    } finally {
      await new Promise((done) => taken.close(done));
    }
  }, 0);

  it('refuses to start anything without a compose program, saying what it takes', async () => {
    const { places, down } = await rootServicesWorld();
    made.push(down);
    await expect(rootServices(['temporal'], { places, env, terminal: terminal() })).rejects.toThrow(/^name the compose program to run them with; usage: root-services\.ts/);
  });
});

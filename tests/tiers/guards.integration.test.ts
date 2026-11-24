import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { here } from '../lib/processes.js';

const run = (project: string, file: string) =>
  here.run({ command: resolve(import.meta.dirname, '../../node_modules/.bin/vitest'), args: ['run', '--project', project, file], cwd: resolve(import.meta.dirname, 'fixture-guards'), env: { KOALA_GATE_FAILURES: '' } });

describe('the guard of each layer', () => {
  it('refuses a component test that starts kubectl, sending it to the container layer', async () => {
    const ran = await run('component', 'spawns-kubectl.component.fixture.ts');
    expect(ran.code).toBe(1);
    expect(ran.stdout + ran.stderr).toContain('it belongs in the container layer: name the file *.container.test.ts');
  });

  it('lets a component test connect to a loopback server of its own', async () => {
    const ran = await run('component', 'own-server.component.fixture.ts');
    expect(ran.stdout + ran.stderr).not.toContain('it belongs in the container layer');
    expect(ran.code).toBe(0);
  });

  it('refuses a component test that connects to a loopback port nothing of its own listens on', async () => {
    const ran = await run('component', 'someone-elses-port.component.fixture.ts');
    expect(ran.code).toBe(1);
    expect(ran.stdout + ran.stderr).toContain('opened a connection to 127.0.0.1:9');
  });

  it('refuses a container test that starts temporal itself, since only the layer\'s global setup does', async () => {
    const ran = await run('container', 'spawns-temporal.container.fixture.ts');
    expect(ran.code).toBe(1);
    expect(ran.stdout + ran.stderr).toContain('only the layer\'s global setup starts k3s, k3d, docker or temporal');
  });
});

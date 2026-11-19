import { describe, expect, it } from 'vitest';
import { childEnv, passedOn } from './child-env.js';

const parent = {
  PATH: '/usr/bin',
  HOME: '/home/someone',
  TMPDIR: '/tmp/someone',
  LANG: 'en_GB.UTF-8',
  LC_TIME: 'en_GB.UTF-8',
  TZ: 'Europe/London',
  SESSION_KEY: 'a key',
  KOALA_DEVICE_TOKEN: 'a token',
  DOCKER_HOST: 'unix:///run/user/1000/docker.sock',
};

describe('the environment a child process starts with', () => {
  it('is the path, home, scratch folder and locale, and nothing else of the parent', () => {
    expect(childEnv({}, parent)).toEqual({ PATH: '/usr/bin', HOME: '/home/someone', TMPDIR: '/tmp/someone', LANG: 'en_GB.UTF-8', LC_TIME: 'en_GB.UTF-8', TZ: 'Europe/London' });
  });

  it('adds what the caller names over the base, and leaves out what it names as unset', () => {
    expect(childEnv({ GIT_TERMINAL_PROMPT: '0', PATH: '/usr/bin:/koala/bin', TZ: undefined }, parent)).toEqual({
      PATH: '/usr/bin:/koala/bin', HOME: '/home/someone', TMPDIR: '/tmp/someone', LANG: 'en_GB.UTF-8', LC_TIME: 'en_GB.UTF-8', GIT_TERMINAL_PROMPT: '0',
    });
  });

  it('hands on how the parent reaches the network, so a child behind a proxy reaches it too', () => {
    expect(childEnv({}, { HTTPS_PROXY: 'http://proxy:3128', no_proxy: 'localhost', NODE_EXTRA_CA_CERTS: '/etc/ca.pem' })).toEqual({ HTTPS_PROXY: 'http://proxy:3128', no_proxy: 'localhost', NODE_EXTRA_CA_CERTS: '/etc/ca.pem' });
  });

  it('hands on Node\'s coverage settings, so a child Node program is measured like its parent', () => {
    expect(childEnv({}, { NODE_V8_COVERAGE: '/coverage', NODE_OPTIONS: '--enable-source-maps' })).toEqual({ NODE_V8_COVERAGE: '/coverage', NODE_OPTIONS: '--enable-source-maps' });
  });

  it('passes on from the parent only the names a caller asks for, and only those it has', () => {
    expect(passedOn(['DOCKER_HOST', 'DOCKER_CONFIG'], parent)).toEqual({ DOCKER_HOST: 'unix:///run/user/1000/docker.sock' });
  });
});

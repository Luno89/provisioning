import { describe, expect, it } from 'vitest';
import { joinArgsOf } from './args.js';

describe('the join\'s arguments, as machine.sh hands them over', () => {
  it('takes the code and everything machine.sh took', () => {
    expect(joinArgsOf(['--url', 'https://root.test/', 'the-code', '--folder', '/home/a/work', '--no-service', '--no-cluster', '--adapters', 'none', '--k3s-mirror', 'http://mirror.test'])).toEqual({
      code: 'the-code', url: 'https://root.test', yes: false, folder: '/home/a/work', service: false, cluster: false, adapters: 'none', k3sMirror: 'http://mirror.test',
    });
  });

  it('installs every adapter without asking under --yes, and asks otherwise', () => {
    expect(joinArgsOf(['--url', 'https://root.test', '--yes', 'c']).adapters).toBe('all');
    expect(joinArgsOf(['--url', 'https://root.test', 'c']).adapters).toBe('ask');
    expect(joinArgsOf(['--url', 'https://root.test', '--yes', '--adapters', 'none', 'c']).adapters).toBe('none');
  });

  it('lets the person\'s own --url win over the one machine.sh was served with', () => {
    expect(joinArgsOf(['--url', 'https://root.test', '--', '--url', 'http://localhost:3002', 'c']).url).toBe('http://localhost:3002');
  });

  it('says how to run it without a code, and refuses what it does not know', () => {
    expect(() => joinArgsOf(['--url', 'https://root.test'])).toThrow('usage: curl -fsSL https://root.test/machine.sh | sh -s -- <code from My Machines>');
    expect(() => joinArgsOf(['--url', 'https://root.test', '--fast', 'c'])).toThrow('unknown option --fast');
    expect(() => joinArgsOf(['--url', 'https://root.test', '--adapters', 'some', 'c'])).toThrow('--adapters takes ask, all, none');
    expect(() => joinArgsOf(['--url', 'https://root.test', 'c', '--folder'])).toThrow('--folder needs a value');
  });
});

import { describe, expect, it } from 'vitest';
import { serviceFiles, stopServiceCommands } from './machine-removal.js';

describe('a machine removed from Koala', () => {
  it('stops and disables the service the install made, so it is not started again', () => {
    expect(stopServiceCommands('linux', 1000, '/home/a')).toEqual([{ file: 'systemctl', args: ['--user', 'disable', '--now', 'koala-machine.service'] }]);
    expect(stopServiceCommands('darwin', 501, '/Users/a')).toEqual([{ file: 'launchctl', args: ['bootout', 'gui/501', '/Users/a/Library/LaunchAgents/dev.koala.machine.plist'] }]);
    expect(stopServiceCommands('win32', 0, 'C:/a')).toEqual([]);
  });

  it('removes the service files the install wrote', () => {
    expect(serviceFiles('linux', {}, '/home/a')).toEqual(['/home/a/.config/systemd/user/koala-machine.service']);
    expect(serviceFiles('linux', { XDG_CONFIG_HOME: '/cfg' }, '/home/a')).toEqual(['/cfg/systemd/user/koala-machine.service']);
    expect(serviceFiles('darwin', {}, '/Users/a')).toEqual(['/Users/a/Library/LaunchAgents/dev.koala.machine.plist']);
  });
});

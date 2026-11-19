import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { K3S_UNINSTALL, type ClusterHost } from './machine-cluster.js';
import { removeThisMachine, serviceFiles, stopServiceCommands } from './machine-removal.js';

const machineWith = (k3s: { before: boolean; after: boolean }) => {
  const host = mock<ClusterHost>();
  let present = k3s.before;
  host.exists.calledWith(K3S_UNINSTALL).mockImplementation(async () => present);
  host.run.mockImplementation(async (file, args) => {
    if (file !== 'sudo' || args.join(' ') !== `-n ${K3S_UNINSTALL}`) throw new Error(`unexpected ${file} ${args.join(' ')}`);
    present = k3s.after;
    return '';
  });
  return host;
};

describe('removing this machine, as root asks or as the reset does', () => {
  it('uninstalls its k3s, with everything Koala ran on it, then forgets the machine', async () => {
    const host = machineWith({ before: true, after: false });
    const forget = vi.fn(async () => undefined);
    await removeThisMachine(host, forget, () => undefined);
    expect(host.run).toHaveBeenCalledWith('sudo', ['-n', K3S_UNINSTALL]);
    expect(host.letKoalaGo).toHaveBeenCalledOnce();
    expect(forget).toHaveBeenCalledOnce();
  });

  it('forgets the machine but says so when its k3s is still there', async () => {
    const host = machineWith({ before: true, after: true });
    const forget = vi.fn(async () => undefined);
    await expect(removeThisMachine(host, forget, () => undefined)).rejects.toThrow(`k3s is still on this machine: ${K3S_UNINSTALL} did not remove it`);
    expect(forget).toHaveBeenCalledOnce();
  });

  it('forgets a machine that never had a k3s of Koala\'s', async () => {
    const host = machineWith({ before: false, after: false });
    const forget = vi.fn(async () => undefined);
    await removeThisMachine(host, forget, () => undefined);
    expect(host.run).not.toHaveBeenCalled();
    expect(forget).toHaveBeenCalledOnce();
  });
});

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

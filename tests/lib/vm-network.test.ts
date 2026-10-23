import { describe, expect, it } from 'vitest';
import { lanNicArgument, macFor, netplanFor } from './vm-network.js';

describe('a VM on a lab network', () => {
  it('gets a locally administered MAC from three bytes', () => {
    expect(macFor(new Uint8Array([0, 10, 255, 9]))).toBe('52:54:00:00:0a:ff');
  });

  it('renders netplan with the uplink on DHCP and the lan static', () => {
    const plan = netplanFor({ uplinkMac: '52:54:00:00:00:01', lan: { mac: '52:54:00:00:00:02', address: '10.77.0.1/24' } });
    expect(plan).toContain('macaddress: "52:54:00:00:00:01"');
    expect(plan).toContain('dhcp4: true');
    expect(plan).toContain('- 10.77.0.1/24');
    expect(plan).not.toContain('nameservers');
    expect(plan).not.toContain('use-dns');
  });

  it('turns the uplink DNS off when the lan names the resolver', () => {
    const plan = netplanFor({ uplinkMac: '52:54:00:00:00:01', lan: { mac: '52:54:00:00:00:02', address: '10.77.0.2/24', nameservers: ['10.77.0.1'] } });
    expect(plan).toContain('use-dns: false');
    expect(plan).toContain('          - 10.77.0.1');
  });

  it('writes the socket nic for the listening and the connecting side', () => {
    expect(lanNicArgument({ listen: 4000 }, '52:54:00:00:00:02')).toBe('socket,listen=127.0.0.1:4000,mac=52:54:00:00:00:02,model=virtio-net-pci');
    expect(lanNicArgument({ connect: 4000 }, '52:54:00:00:00:03')).toBe('socket,connect=127.0.0.1:4000,mac=52:54:00:00:00:03,model=virtio-net-pci');
  });
});

import { describe, expect, it } from 'vitest';
import { endsWith, failedUpgradeReports, imageTagOf, inFlightRefusal, labDnsmasq, labHostsLine, noted, revisionRunning, upgradeReports } from './release-lab.js';

describe('the release lab', () => {
  it('names an image by the first twelve characters of its commit', () => {
    expect(imageTagOf('1447051c397bba04c018d9521f871571f5124e63')).toBe('1447051c397b');
  });

  it('points the app and mesh names at root in a hosts line', () => {
    expect(labHostsLine('koala.internal', '10.77.0.1')).toBe('10.77.0.1 app.koala.internal mesh.koala.internal');
  });

  it('answers every name under the domain with root from dnsmasq on the lan and loopback only', () => {
    expect(labDnsmasq('koala.internal', '10.77.0.1')).toBe('bind-interfaces\nlisten-address=10.77.0.1,127.0.0.1\naddress=/koala.internal/10.77.0.1\n');
  });

  it('keeps a trail of what root reported, without repeats', () => {
    let trail = noted([], { status: 'ready', detail: 'Installed' });
    trail = noted(trail, { status: 'ready', detail: 'Installed' });
    trail = noted(trail, { status: 'installing', detail: 'Upgrading from a to b' });
    trail = noted(trail, { status: 'ready', detail: 'Upgraded to b' });
    expect(trail).toEqual([
      { status: 'ready', detail: 'Installed' },
      { status: 'installing', detail: 'Upgrading from a to b' },
      { status: 'ready', detail: 'Upgraded to b' },
    ]);
  });

  it('knows the reports a good and a failed upgrade end with', () => {
    const good = noted(noted([{ status: 'ready', detail: 'Installed' }], { status: 'installing', detail: 'Upgrading from a to b' }), { status: 'ready', detail: 'Upgraded to b' });
    expect(endsWith(good, upgradeReports('a', 'b'))).toBe(true);
    expect(endsWith(good, failedUpgradeReports('a', 'b'))).toBe(false);
    expect(endsWith([{ status: 'ready', detail: 'Upgraded to b' }], upgradeReports('a', 'b'))).toBe(false);
    expect(failedUpgradeReports('a', 'nothing')).toEqual([
      { status: 'installing', detail: 'Upgrading from a to nothing' },
      { status: 'failed', detail: 'The upgrade to nothing failed, so it was rolled back to a' },
    ]);
  });

  it('says what update.sh refuses with', () => {
    expect(inFlightRefusal(1)).toBe('1 workflow(s) are running. Wait, or re-run with --force (costs them one retry attempt).');
  });

  it('finds the last helm revision that ran a tag', () => {
    const history = [
      { revision: 1, values: { image: { tag: 'a' } } },
      { revision: 2, values: { image: { tag: 'b' } } },
      { revision: 3, values: { image: { tag: 'nothing' } } },
      { revision: 4, values: { image: { tag: 'b' } } },
    ];
    expect(revisionRunning(history, 'a')).toBe(1);
    expect(revisionRunning(history, 'b')).toBe(4);
    expect(revisionRunning(history, 'c')).toBeUndefined();
  });
});

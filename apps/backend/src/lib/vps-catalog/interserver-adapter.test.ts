import { describe, it, expect } from 'vitest';
import { interserverOffersFromSliceXml } from './adapters.js';

/**
 * InterServer is the one adapter whose SPECS are not derived from the API — its
 * get_vps_slice_types call returns the cost per slice and nothing about what a slice contains
 * (all 119 SOAP operations were checked). The ladder is therefore transcribed from
 * https://www.interserver.net/vps/ and pinned here.
 *
 * If InterServer changes what a slice contains, these tests are the thing that notices. The price
 * cannot drift the same way — it comes from the API.
 */
const item = (name: string, cost: string, buyable: string, type = '14') =>
  `<item xsi:type="tns:vps_slice_type">` +
  `<name xsi:type="xsd:string">${name}</name>` +
  `<type xsi:type="xsd:int">${type}</type>` +
  `<cost xsi:type="xsd:float">${cost}</cost>` +
  `<buyable xsi:type="xsd:int">${buyable}</buyable>` +
  `</item>`;

const envelope = (...items: string[]) =>
  `<?xml version="1.0" encoding="ISO-8859-1"?><SOAP-ENV:Envelope><SOAP-ENV:Body>` +
  `<ns1:get_vps_slice_typesResponse><return SOAP-ENC:arrayType="tns:vps_slice_type[${items.length}]">` +
  items.join('') +
  `</return></ns1:get_vps_slice_typesResponse></SOAP-ENV:Body></SOAP-ENV:Envelope>`;

describe('interserverOffersFromSliceXml', () => {
  const xml = envelope(
    item('KVM Linux VPS Slice', '3.00', '1'),
    item('OpenVZ VPS Slice', '3.00', '1', '6'),
    item('Cloud KVM Linux VPS Slice', '10.00', '0', '4'), // not buyable
    item('KVM Windows VPS Slice', '5.00', '1', '15'), // Windows
    item('Hyper-V VPS Slice', '5.00', '1', '11'), // Windows hypervisor
    item('KVM Storage', '3.00', '1', '16'), // disk add-on, not a machine
    item('KVM Linux IPv6 Only VPS Slice', '2.50', '1'), // unreachable over IPv4
  );
  const { offers, skippedNoPrice } = interserverOffersFromSliceXml(xml);
  const kvm = offers.filter((o) => o.planId.startsWith('kvm-linux-vps-slice'));

  it('emits the advertised tiers for each buyable Linux slice type', () => {
    // Two eligible types (KVM Linux, OpenVZ) × 5 advertised tiers.
    expect(offers).toHaveLength(10);
    expect(kvm).toHaveLength(5);
  });

  it('reproduces the published ladder exactly', () => {
    // Straight from the pricing page: slices → vCores / RAM / disk / transfer.
    const expected = [
      { slices: 1, vcpu: 1, ramGb: 2, diskGb: 40, bandwidthTb: 2, priceMonthly: 3 },
      { slices: 4, vcpu: 2, ramGb: 8, diskGb: 160, bandwidthTb: 8, priceMonthly: 12 },
      { slices: 8, vcpu: 4, ramGb: 16, diskGb: 320, bandwidthTb: 16, priceMonthly: 24 },
      { slices: 16, vcpu: 8, ramGb: 32, diskGb: 640, bandwidthTb: 32, priceMonthly: 48 },
      { slices: 32, vcpu: 16, ramGb: 64, diskGb: 1280, bandwidthTb: 64, priceMonthly: 96 },
    ];
    for (const e of expected) {
      const offer = kvm.find((o) => o.planId.endsWith(`-${e.slices}`));
      expect(offer, `${e.slices} slices`).toMatchObject({
        vcpu: e.vcpu, ramGb: e.ramGb, diskGb: e.diskGb,
        bandwidthTb: e.bandwidthTb, priceMonthly: e.priceMonthly,
      });
    }
  });

  it('derives price from the API cost per slice, so pricing cannot go stale', () => {
    const cheaper = interserverOffersFromSliceXml(envelope(item('KVM Linux VPS Slice', '2.00', '1')));
    expect(cheaper.offers.find((o) => o.planId.endsWith('-8'))?.priceMonthly).toBe(16);
  });

  it('vCores do not scale linearly — 1 slice gives 1 core, not half of one', () => {
    // The reason the ladder is a table rather than a multiply.
    expect(kvm.find((o) => o.planId.endsWith('-1'))?.vcpu).toBe(1);
    expect(kvm.find((o) => o.planId.endsWith('-4'))?.vcpu).toBe(2);
  });

  it('excludes slice types that are not orderable', () => {
    expect(offers.some((o) => o.label.includes('Cloud KVM'))).toBe(false);
  });

  it('excludes Windows, which costs more and cannot run k3s', () => {
    expect(offers.some((o) => /windows|hyper-v/i.test(o.label))).toBe(false);
  });

  it('excludes Storage slices, which are disk add-ons rather than machines', () => {
    expect(offers.some((o) => /storage/i.test(o.label))).toBe(false);
  });

  it('excludes IPv6-only slices, which this platform could never reach', () => {
    // Cheaper and genuinely tempting, but SSH bootstrap and the 100.64.0.0/10 mesh both assume
    // IPv4 — cataloguing one as usable would strand whoever picked it.
    expect(offers.some((o) => /ipv6/i.test(o.label))).toBe(false);
  });

  it('quotes USD net, matching the convention the other adapters use', () => {
    expect(offers.every((o) => o.currency === 'USD' && o.taxIncluded === false)).toBe(true);
  });

  it('is catalogue-only until an ordering path exists', () => {
    expect(offers.every((o) => o.provisionable === false)).toBe(true);
  });

  it('counts an unpriced slice type rather than emitting a free plan', () => {
    const r = interserverOffersFromSliceXml(envelope(item('Broken Slice', '0', '1')));
    expect(r.offers).toHaveLength(0);
    expect(r.skippedNoPrice).toBe(1);
  });

  it('survives empty or malformed XML', () => {
    expect(interserverOffersFromSliceXml('').offers).toEqual([]);
    expect(interserverOffersFromSliceXml('<html>down for maintenance</html>').offers).toEqual([]);
    expect(() => interserverOffersFromSliceXml('<item></item>')).not.toThrow();
  });

  it('produces unique ids across types and tiers', () => {
    expect(new Set(offers.map((o) => o.id)).size).toBe(offers.length);
  });
});

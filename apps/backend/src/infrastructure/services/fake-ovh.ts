import { ovhSignature } from '../lib/ovh-api.js';
import type { FetchLike } from './OvhClient.js';

export interface FakeOvhState {
  status: string;
  withTax: number;
  checkedOut: number;
  deletedCarts: string[];
  rebuilt: { serviceName: string; body: Record<string, unknown> }[];
  calls: string[];
  reverses: Record<string, string>;
  reverseRefusal?: { status: number; message: string } | undefined;
  me: { nichandle: string; ovhSubsidiary: string; currency: { code: string } };
}

export const FAKE_OVH_KEYS = { applicationKey: 'AK-test', applicationSecret: 'AS-test', consumerKey: 'CK-test' };

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export function fakeOvh(overrides: Partial<FakeOvhState> = {}): { fetch: FetchLike; state: FakeOvhState } {
  const state: FakeOvhState = {
    status: 'delivered',
    withTax: 15.4,
    checkedOut: 0,
    deletedCarts: [],
    rebuilt: [],
    calls: [],
    reverses: {},
    me: { nichandle: 'ab12345-ovh', ovhSubsidiary: 'AU', currency: { code: 'AUD' } },
    ...overrides,
  };
  const fetchImpl: FetchLike = async (input, init = {}) => {
    const url = new URL(input);
    const method = (init.method ?? 'GET').toUpperCase();
    const path = url.pathname.replace(/^\/1\.0/, '');
    if (path === '/auth/time') return json(1_700_000_000);
    const headers = init.headers as Record<string, string>;
    const body = typeof init.body === 'string' ? init.body : '';
    const expected = ovhSignature(FAKE_OVH_KEYS, method, input, body, Number(headers['X-Ovh-Timestamp']));
    if (headers['X-Ovh-Application'] !== FAKE_OVH_KEYS.applicationKey || headers['X-Ovh-Signature'] !== expected) {
      return json({ message: 'Invalid signature' }, 400);
    }
    state.calls.push(`${method} ${path}${url.search}`);
    const sent = body ? JSON.parse(body) as Record<string, unknown> : {};
    let match: RegExpExecArray | null;
    if (method === 'GET' && path === '/me') return json(state.me);
    if (method === 'POST' && path === '/order/cart') return json({ cartId: 'cart-1', expire: '2026-11-01T00:00:00Z', items: [] });
    if (method === 'POST' && /^\/order\/cart\/[^/]+\/assign$/.test(path)) return json(null);
    if (method === 'POST' && /^\/order\/cart\/[^/]+\/vps$/.test(path)) return json({ itemId: 7, productId: 'vps', settings: { planCode: sent.planCode } });
    if (method === 'GET' && /^\/order\/cart\/[^/]+\/item\/7\/requiredConfiguration$/.test(path)) {
      return json([{ label: 'vps_datacenter', required: true, type: 'String', allowedValues: ['SYD', 'SGP'] }, { label: 'vps_os', required: false, type: 'String' }]);
    }
    if (method === 'POST' && /^\/order\/cart\/[^/]+\/item\/7\/configuration$/.test(path)) return json({ id: 1, label: sent.label, value: sent.value });
    if (method === 'GET' && /^\/order\/cart\/[^/]+\/vps\/options$/.test(path)) {
      return json([
        { planCode: 'option-auto-backup-2027-1-model2', family: 'automatedBackup', mandatory: true, prices: [{ duration: 'P1M', pricingMode: 'default', price: { value: 0 } }] },
        { planCode: 'option-storage-local-2027-model2', family: 'storage', mandatory: true, prices: [{ duration: 'P1M', pricingMode: 'default', price: { value: 0 } }] },
        { planCode: 'option-linux', family: 'os', mandatory: true, prices: [{ duration: 'P1M', pricingMode: 'default', price: { value: 0 } }] },
        { planCode: 'option-windows', family: 'os', mandatory: false, prices: [{ duration: 'P1M', pricingMode: 'default', price: { value: 20 } }] },
      ]);
    }
    if (method === 'POST' && /^\/order\/cart\/[^/]+\/vps\/options$/.test(path)) return json({ itemId: 8, settings: { planCode: sent.planCode } });
    if (method === 'GET' && /^\/order\/cart\/[^/]+\/checkout$/.test(path)) {
      return json({
        prices: { withoutTax: { value: 14, currencyCode: 'AUD' }, tax: { value: Math.round((state.withTax - 14) * 100) / 100, currencyCode: 'AUD' }, withTax: { value: state.withTax, currencyCode: 'AUD' } },
        details: [{ description: 'VPS-2 2027', detailType: 'DURATION', totalPrice: { value: 14 } }, { description: 'Installation', detailType: 'INSTALLATION', totalPrice: { value: 0 } }],
        contracts: [{ name: 'General Terms of Service', url: 'https://example.ovh/terms.pdf' }],
      });
    }
    if (method === 'POST' && /^\/order\/cart\/[^/]+\/checkout$/.test(path)) {
      state.checkedOut += 1;
      return json({ orderId: 123456, url: 'https://ca.ovh.com/order/123456' });
    }
    if (method === 'DELETE' && (match = /^\/order\/cart\/([^/]+)$/.exec(path))) {
      state.deletedCarts.push(match[1]!);
      return json(null);
    }
    if (method === 'GET' && /^\/me\/order\/\d+\/status$/.test(path)) return json(state.status);
    if (method === 'GET' && /^\/me\/order\/\d+\/associatedObject$/.test(path)) return json({ id: 'vps-a1b2c3.vps.ovh.ca', type: 'VPS' });
    if (method === 'GET' && /^\/vps\/[^/]+\/images\/available$/.test(path)) return json(['img-debian', 'img-ubuntu']);
    if (method === 'GET' && (match = /^\/vps\/[^/]+\/images\/available\/([^/]+)$/.exec(path))) {
      return json({ id: match[1], name: match[1] === 'img-ubuntu' ? 'Ubuntu 24.04' : 'Debian 13' });
    }
    if (method === 'POST' && (match = /^\/vps\/([^/]+)\/rebuild$/.exec(path))) {
      state.rebuilt.push({ serviceName: match[1]!, body: sent });
      return json({ id: 99, state: 'todo', type: 'reinstallVm' });
    }
    if (method === 'GET' && /^\/vps\/[^/]+\/ips$/.test(path)) return json(['2001:db8::1', '203.0.113.7']);
    if (method === 'GET' && path === '/ip') {
      const asked = url.searchParams.get('ip');
      return json(asked === '203.0.113.7' ? ['203.0.113.7/32'] : asked === '2001:db8::1' ? ['2001:db8::/64'] : []);
    }
    if ((match = /^\/ip\/([^/]+)\/reverse(?:\/([^/]+))?$/.exec(path))) {
      const block = decodeURIComponent(match[1]!);
      if (block !== '203.0.113.7/32' && block !== '2001:db8::/64') return json({ message: `The requested object (ip = ${block}) does not exist` }, 404);
      const address = match[2] ? decodeURIComponent(match[2]) : undefined;
      if (method === 'GET' && address) {
        const reverse = state.reverses[address];
        return reverse ? json({ ipReverse: address, reverse }) : json({ message: `The requested object (ipReverse = ${address}) does not exist` }, 404);
      }
      if (method === 'POST' && !address) {
        if (state.reverseRefusal) return json({ message: state.reverseRefusal.message }, state.reverseRefusal.status);
        if (typeof sent.ipReverse !== 'string' || typeof sent.reverse !== 'string') return json({ message: 'Missing parameter' }, 400);
        state.reverses[sent.ipReverse] = sent.reverse;
        return json({ ipReverse: sent.ipReverse, reverse: sent.reverse });
      }
    }
    return json({ message: `fake OVHcloud has no ${method} ${path}` }, 404);
  };
  return { fetch: fetchImpl, state };
}
